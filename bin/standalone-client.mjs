#!/usr/bin/env node
// Palier 4-bis — Standalone Figma multiplayer client.
//
// Opens our OWN WebSocket directly to Figma's multiplayer endpoint, using cookies
// stolen from a logged-in Chrome session via recon-handshake.mjs. Does NOT touch
// the user's Chrome at all once the recon is done.
//
// Workflow:
//   1. node bin/recon-handshake.mjs --match biblioth   # produces /tmp/figma_handshake.json
//   2. node bin/standalone-client.mjs --guid 2004:16177 --name HELLO_FROM_KIWI
//
// What it does:
//   - Reads handshake.json for the multiplayer URL pattern + cookies
//   - Opens a fresh ws:// connection with those cookies + Origin header
//   - Decodes inbound frames (zstd → Kiwi) live to learn sessionID + ackID
//   - Builds a minimal {guid, name} mutation, encodes, compresses, sends
//   - Watches for the server's ack (recv NODE_CHANGES echoing our ackID) to confirm
//
// Args:
//   --handshake  path  default /tmp/figma_handshake.json
//   --kiwi-dir   path  dir holding figma_decoder.js (default /tmp/figma_full_sync)
//   --guid       sessionID:localID    target node
//   --field      name (default 'name')
//   --value      string value
//   --dry-run    decode + assemble but don't send

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const WebSocket = require('/tmp/node_modules/ws');

// --- args ---
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
const handshakePath = arg('handshake', '/tmp/figma_handshake.json');
const kiwiDir = arg('kiwi-dir', '/tmp/figma_full_sync');
const guidArg = arg('guid', '2004:16177');
const fieldName = arg('field', 'name');
const fieldValue = arg('value', arg('name-value', 'HELLO_FROM_STANDALONE'));
const dryRun = argv.includes('--dry-run');

const [guidSession, guidLocal] = guidArg.split(':').map(Number);

// --- load handshake + schema ---
const hs = JSON.parse(readFileSync(handshakePath, 'utf8'));
const Schema = require(`${kiwiDir}/figma_decoder.js`);

// Find the multiplayer socket entry (not livegraph)
const mp = hs.sockets.find(s => /\/api\/multiplayer\//.test(s.url));
if (!mp) { console.error('No multiplayer URL in handshake.json'); process.exit(1); }
console.error(`Multiplayer URL pattern: ${mp.url.slice(0, 80)}...`);

// Rotate tracking_session_id with a regex on the raw URL string. We must NOT use
// URL.searchParams here — it percent-encodes the colon in `scenegraph-queries-initial-nodes=0:1`
// and adds an `=` to the bare `file-load-streaming-compression` flag, both of which the
// Figma server parses strictly and will silently fail to fully sync if changed.
const newTSID = randomBytes(8).toString('base64url').slice(0, 16);
const wsUrl = mp.url.replace(/tracking_session_id=[^&]+/, `tracking_session_id=${newTSID}`);
console.error(`Connecting to: ${wsUrl.slice(0, 100)}...`);

// Build cookie header from the figma.com cookies we captured
const cookieHeader = hs.cookies.map(c => `${c.name}=${c.value}`).join('; ');
console.error(`Sending ${hs.cookies.length} cookies (${cookieHeader.length} chars)`);

const headers = {
  Origin: 'https://www.figma.com',
  'User-Agent': mp.requestHeaders?.['User-Agent'] || mp.requestHeaders?.['user-agent'] || 'Mozilla/5.0',
  Cookie: cookieHeader,
};

// --- connect ---
const ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false });

let probedSessionID = null;
let probedAckID = null;
let sentAckID = null;
let serverConfirmed = false;

function tryDecode(buf) {
  const u8 = new Uint8Array(buf);
  const isZstd = u8[0]===0x28 && u8[1]===0xb5 && u8[2]===0x2f && u8[3]===0xfd;
  const dec = isZstd ? new Uint8Array(zstdDecompressSync(buf)) : u8;
  try { return Schema.decodeMessage(dec); } catch (e) { return { __decodeError: e.message }; }
}

ws.on('open', () => {
  console.error(`✓ WebSocket OPEN`);
});

ws.on('message', async (data, isBinary) => {
  if (!isBinary) {
    console.error(`[recv text ${data.length}b] ${data.toString('utf8').slice(0, 120)}`);
    return;
  }
  // Skip the fig-wire schema frame (magic header) — we already have the decoder
  const u8 = new Uint8Array(data);
  // Crude detection: fig-wire frames start with a specific magic
  const isFigWire = u8.length > 8 && u8[0] === 0x66 && u8[1] === 0x69 && u8[2] === 0x67;
  if (isFigWire) {
    console.error(`[recv schema ${data.length}b] (skipped — already have decoder)`);
    return;
  }
  const m = tryDecode(data);
  if (m.__decodeError) {
    console.error(`[recv ${data.length}b] decode error: ${m.__decodeError.slice(0, 80)}`);
    return;
  }
  const summary = `type=${m.type} sessionID=${m.sessionID ?? '-'} ackID=${m.ackID ?? '-'} nodeChanges=${m.nodeChanges?.length ?? 0}`;
  console.error(`[recv ${data.length}b] ${summary}`);

  if (m.sessionID != null && probedSessionID == null) probedSessionID = m.sessionID;
  if (m.ackID != null) probedAckID = m.ackID;

  // Did the server echo back our mutation?
  if (sentAckID != null && m.ackID === sentAckID) {
    serverConfirmed = true;
    console.error(`\n🎉 SERVER ACK RECEIVED — ackID ${sentAckID} echoed back. Mutation accepted.`);
    for (const c of (m.nodeChanges || [])) {
      console.error(`   echoed: guid=${c.guid?.sessionID}:${c.guid?.localID} fields=[${Object.keys(c).join(',')}]`);
    }
    setTimeout(() => ws.close(1000), 500);
  }

  // Once we have sessionID + ackID and haven't sent yet, fire the mutation
  if (probedSessionID != null && probedAckID != null && sentAckID == null && !dryRun) {
    sendMutation();
  }
});

ws.on('close', (code, reason) => {
  console.error(`\n[ws closed] code=${code} reason="${reason?.toString() || ''}"`);
  if (sentAckID != null && !serverConfirmed) {
    console.error('⚠ Sent but no ack received — server may have rejected silently or close came first.');
  }
  process.exit(serverConfirmed ? 0 : 2);
});

ws.on('error', (err) => {
  console.error('ws error:', err.message);
  process.exit(1);
});

function sendMutation() {
  const mutation = {
    type: 'NODE_CHANGES',
    sessionID: probedSessionID,
    ackID: probedAckID + 25,
    sentTimestamp: BigInt(Date.now()),
    nodeChanges: [
      {
        guid: { sessionID: guidSession, localID: guidLocal },
        [fieldName]: fieldValue,
      },
    ],
  };
  sentAckID = mutation.ackID;
  console.error(`\n>>> Sending mutation:`);
  console.error(`    sessionID=${mutation.sessionID} ackID=${mutation.ackID}`);
  console.error(`    target guid=${guidSession}:${guidLocal} ${fieldName}="${fieldValue}"`);

  const encoded = Schema.encodeMessage(mutation);
  const compressed = zstdCompressSync(Buffer.from(encoded));
  console.error(`    encoded ${encoded.length}b → compressed ${compressed.length}b`);
  ws.send(compressed, { binary: true }, (err) => {
    if (err) console.error('send error:', err.message);
  });
  // Bail if no ack within 10s
  setTimeout(() => {
    if (!serverConfirmed) {
      console.error('⚠ No server ack within 10s after send — likely silent reject.');
      ws.close(1000);
    }
  }, 10000);
}

// Safety: max 30s lifetime even if nothing happens
setTimeout(() => {
  console.error('Lifetime cap reached, closing.');
  ws.close(1000);
}, 30000);
