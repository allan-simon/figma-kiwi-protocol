#!/usr/bin/env node
// Palier 4 — first write test against a live Figma session.
//
// What it does:
//   1. Connects directly to a Figma page's CDP endpoint
//   2. Monkey-patches WebSocket.prototype.send in the page to capture (a) the
//      live socket reference and (b) the last raw outgoing payload (zstd Kiwi)
//   3. Waits a few seconds for any cursor/heartbeat traffic
//   4. Pulls the captured payload back to Node, decompresses + decodes via Kiwi
//      to extract the current sessionID and ackID
//   5. Builds a minimal NODE_CHANGES mutation that renames a target node, encodes
//      it with the same Kiwi schema, compresses with native node:zlib zstd
//   6. Calls send() on the captured WebSocket from inside the page, passing the
//      payload back as base64 → Uint8Array
//
// Usage:
//   FIGMA_KIWI_DIR=/tmp/figma_full_sync \
//   CDP_WS_URL="ws://172.17.0.1:9223/devtools/browser/<id>" \
//   node bin/inject-test.mjs --guid 2004:16177 --name HELLO_FROM_KIWI_INJECT
//
// The schema decoder (figma_decoder.js) and a captured fig-wire frame must
// already exist in FIGMA_KIWI_DIR (run `figma-kiwi-protocol capture` once).

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);

// --- args ---
const argv = process.argv.slice(2);
function getArg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
const guidArg = getArg('guid', '2004:16177'); // WRITE_TEST_RENAME_001
const newName = getArg('name', 'HELLO_FROM_KIWI_INJECT');
const matchSubstr = (getArg('match', 'biblioth') || '').toLowerCase();
const dryRun = argv.includes('--dry-run');

const [guidSession, guidLocal] = guidArg.split(':').map(Number);
if (!Number.isFinite(guidSession) || !Number.isFinite(guidLocal)) {
  console.error(`Bad --guid format: "${guidArg}" — expected "sessionID:localID"`);
  process.exit(1);
}

const wsUrl = process.env.CDP_WS_URL;
const DIR = process.env.FIGMA_KIWI_DIR;
if (!wsUrl) { console.error('Set CDP_WS_URL'); process.exit(1); }
if (!DIR) { console.error('Set FIGMA_KIWI_DIR (must contain figma_decoder.js)'); process.exit(1); }

// --- load schema ---
const Schema = require(`${DIR}/figma_decoder.js`);
console.error(`Loaded schema (${Object.keys(Schema).filter(k=>/^encode/.test(k)).length} encoders)`);

// --- find Figma tab ---
const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
const targets = await fetch(`${httpBase}/json`).then(r => r.json());
const tab = targets.find(t =>
  t.url?.includes('figma.com/design') &&
  (!matchSubstr || t.url.toLowerCase().includes(matchSubstr))
);
if (!tab) {
  console.error(`No Figma tab matching "${matchSubstr}"`);
  for (const t of targets.filter(t => t.url?.includes('figma.com'))) {
    console.error(`  ${t.title?.slice(0, 60)} — ${t.url.slice(0, 90)}`);
  }
  process.exit(1);
}
console.error(`Target: ${tab.title}`);

// --- connect to the page CDP endpoint (not browser) ---
// Each tab has its own webSocketDebuggerUrl that lets us drive Runtime/Page commands directly,
// so we don't need Target.attachToTarget bookkeeping.
const pageWs = new WebSocket(tab.webSocketDebuggerUrl);
let cdpId = 1;
const inflight = new Map();
function cdp(method, params = {}) {
  const id = cdpId++;
  pageWs.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => inflight.set(id, { resolve, reject }));
}
pageWs.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && inflight.has(msg.id)) {
    const { resolve, reject } = inflight.get(msg.id);
    inflight.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
// Capture inbound WS frames via CDP Network domain — that's where NODE_CHANGES with
// the current sessionID + ackID will appear without us having to wait for the user
// to mutate something. The server emits acks and other-user edits constantly.
const inboundFrames = [];           // binary opcode-2 only (the Figma multiplayer wire)
const seenMethods = new Map();
const wsByRequestId = new Map();    // requestId → { url, recv:int, sent:int, opcodesRecv:Set, opcodesSent:Set }
pageWs.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method) seenMethods.set(msg.method, (seenMethods.get(msg.method) || 0) + 1);
  if (msg.method === 'Network.webSocketCreated') {
    wsByRequestId.set(msg.params.requestId, { url: msg.params.url, recv: 0, sent: 0, opcodesRecv: new Set(), opcodesSent: new Set() });
  }
  if (msg.method === 'Network.webSocketFrameReceived') {
    const w = wsByRequestId.get(msg.params.requestId);
    if (w) { w.recv++; w.opcodesRecv.add(msg.params.response.opcode); }
    if (msg.params.response.opcode === 2) inboundFrames.push(msg.params.response.payloadData);
  }
  if (msg.method === 'Network.webSocketFrameSent') {
    const w = wsByRequestId.get(msg.params.requestId);
    if (w) { w.sent++; w.opcodesSent.add(msg.params.response.opcode); }
  }
});

await new Promise((res, rej) => {
  pageWs.addEventListener('open', res, { once: true });
  pageWs.addEventListener('error', rej, { once: true });
});
await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Network.enable');

// --- step 1: install the WebSocket.prototype.send hook BEFORE Figma's bundle loads,
// via Page.addScriptToEvaluateOnNewDocument. Then reload the page so the hook applies
// to a fresh Figma WS handshake. This is the only reliable way: patching the prototype
// after Figma's bundle has already grabbed a private reference to send() does nothing.
const preloadScript = `
(() => {
  if (window.__kiwiInjectPatched) return;
  window.__kiwiInjectPatched = true;
  window.__kiwiCapturedWS = null;
  window.__kiwiSentRing = [];
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    try {
      if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        // Tag any WS that ever sent binary as the candidate; Figma's multiplayer is the only one
        if (this.url && /figma/.test(this.url)) {
          window.__kiwiCapturedWS = this;
          const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          let bin = '';
          for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
          window.__kiwiSentRing.push(btoa(bin));
          if (window.__kiwiSentRing.length > 100) window.__kiwiSentRing.shift();
        }
      }
    } catch (e) {}
    return orig.call(this, data);
  };
})();
`;
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: preloadScript });
console.error('Pre-patch installed (will run on next page load).');

// Wait for Page.loadEventFired before proceeding past reload
const loadFired = new Promise((resolve) => {
  const handler = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.loadEventFired') { pageWs.removeEventListener('message', handler); resolve(); }
  };
  pageWs.addEventListener('message', handler);
});
console.error('Reloading the Figma tab...');
await cdp('Page.reload', { ignoreCache: false });
await Promise.race([loadFired, new Promise(r => setTimeout(r, 15000))]);
console.error('Page load fired (or 15s timeout). Waiting 4s for Figma WS handshake to complete...');
await new Promise(r => setTimeout(r, 4000));

// --- step 2: pull sessionID + ackID from any source ---
// After the reload above, two things happen:
//   - Inbound frames flood in as the server pushes the full file state. The first
//     NODE_CHANGES recv carries sessionID + ackID (echoed from the client's first
//     handshake send).
//   - Once Figma's bundle finishes initialising, the window.__kiwiSentRing populated
//     by our preload-script patch will have at least one NODE_CHANGES sent.
// We try inbound CDP frames first (zero user interaction needed), and fall back to
// the in-page ring if those don't carry NODE_CHANGES quickly enough.
function tryDecode(b64orRaw) {
  const raw = typeof b64orRaw === 'string' ? Buffer.from(b64orRaw, 'base64') : Buffer.from(b64orRaw);
  const dec = (raw[0]===0x28&&raw[1]===0xb5&&raw[2]===0x2f&&raw[3]===0xfd) ? zstdDecompressSync(raw) : raw;
  try { return Schema.decodeMessage(new Uint8Array(dec)); } catch { return null; }
}

console.error(`Captured ${inboundFrames.length} inbound frames during reload window.`);

let probedSessionID = null;
let probedAckID = null;
function tryProbe(p) {
  if (!p || p.type !== 'NODE_CHANGES') return false;
  if (p.sessionID == null || p.ackID == null) return false;
  probedSessionID = p.sessionID;
  probedAckID = p.ackID;
  return true;
}

// Drain anything already received
for (const b64 of inboundFrames) if (tryProbe(tryDecode(b64))) break;

let waited = 0;
while ((probedSessionID == null || probedAckID == null) && waited < 60) {
  await new Promise(r => setTimeout(r, 500));
  waited++;
  // Drain new inbound frames
  while (inboundFrames.length) {
    if (tryProbe(tryDecode(inboundFrames.shift()))) break;
  }
  if (probedSessionID != null) break;
  // Fallback: scan the in-page sent ring for NODE_CHANGES
  const ring = await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__kiwiSentRing || [])',
    returnByValue: true,
  });
  const arr = JSON.parse(ring.result.value || '[]');
  for (const b64 of arr) if (tryProbe(tryDecode(b64))) break;
  if (waited % 4 === 0) console.error(`  …${waited / 2}s, ring size=${arr.length} inbound queue=${inboundFrames.length}`);
}
if (probedSessionID == null || probedAckID == null) {
  console.error('Timed out — no NODE_CHANGES seen in 30s after reload.');
  console.error('\nWebSockets observed by CDP:');
  for (const [reqId, w] of wsByRequestId) {
    console.error(`  ${reqId}  recv=${w.recv} (opcodes ${[...w.opcodesRecv].join(',')||'-'})  sent=${w.sent} (opcodes ${[...w.opcodesSent].join(',')||'-'})`);
    console.error(`    url=${w.url}`);
  }
  // Also dump what the in-page hook saw
  const dumpHook = await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({patched: !!window.__kiwiInjectPatched, captured: !!window.__kiwiCapturedWS, capturedUrl: window.__kiwiCapturedWS?.url, capturedReadyState: window.__kiwiCapturedWS?.readyState, ringSize: (window.__kiwiSentRing||[]).length})',
    returnByValue: true,
  });
  console.error(`\nIn-page hook state: ${dumpHook.result.value}`);
  process.exit(3);
}
console.error(`✓ sessionID=${probedSessionID} ackID=${probedAckID}`);
console.error(`Live session: sessionID=${probedSessionID} ackID=${probedAckID}`);

// --- step 4: build the mutation ---
// Hypothesis-minimal: no editInfo, no editScopeInfo, no companion {guid:0:1} change.
const mutation = {
  type: 'NODE_CHANGES',
  sessionID: probedSessionID,
  ackID: probedAckID + 25, // gap matches the +21 increment Figma uses, +4 buffer
  sentTimestamp: BigInt(Date.now()),
  nodeChanges: [
    {
      guid: { sessionID: guidSession, localID: guidLocal },
      name: newName,
    },
  ],
};
console.error('Mutation:', {
  type: mutation.type,
  sessionID: mutation.sessionID,
  ackID: mutation.ackID,
  guid: `${guidSession}:${guidLocal}`,
  name: newName,
});

const encoded = Schema.encodeMessage(mutation);
const compressed = zstdCompressSync(Buffer.from(encoded));
console.error(`Encoded ${encoded.length}b → compressed ${compressed.length}b`);

if (dryRun) {
  console.error('--dry-run: not sending');
  process.exit(0);
}

// --- step 5: inject via the captured socket ---
const payloadB64 = compressed.toString('base64');
const sendSrc = `
(() => {
  if (!window.__kiwiCapturedWS) return 'no-ws';
  const u8 = Uint8Array.from(atob(${JSON.stringify(payloadB64)}), c => c.charCodeAt(0));
  try {
    window.__kiwiCapturedWS.send(u8);
    return 'sent ' + u8.length;
  } catch (e) {
    return 'send-failed: ' + (e && e.message);
  }
})()
`;
const sendResult = await cdp('Runtime.evaluate', { expression: sendSrc, returnByValue: true });
console.error(`Inject result: ${sendResult.result.value}`);

console.error('\nNow check Figma — the target layer should have a new name.');
console.error('If nothing changed, the server silently rejected the message.');
console.error('Re-run capture-then-decode to inspect what came back.');

pageWs.close();
