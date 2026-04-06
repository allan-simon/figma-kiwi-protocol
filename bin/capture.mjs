#!/usr/bin/env node
// Capture Figma WebSocket binary frames via Chrome DevTools Protocol.
// Reloads the Figma tab and saves all binary WS frames to disk.
//
// Usage:
//   CDP_WS_URL="ws://host:port/devtools/browser/<id>" figma-kiwi capture [seconds]
//
// Environment:
//   CDP_WS_URL       Chrome DevTools WebSocket URL (required)
//   FIGMA_KIWI_DIR   Output directory (default: /tmp/figma_kiwi)

import { writeFileSync, mkdirSync } from 'fs';
import { isFigWireFrame } from '../lib/kiwi.mjs';

const wsUrl = process.env.CDP_WS_URL;
if (!wsUrl) {
  console.error('CDP_WS_URL not set. Start Chrome with --remote-debugging-port=9222');
  console.error('then set CDP_WS_URL to the browser WebSocket URL.');
  process.exit(1);
}

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
mkdirSync(DIR, { recursive: true });

// CLI flags (positional [seconds] still supported as first non-flag arg)
//   --no-reload          Attach without reloading the page (preserves user's live edits — needed
//                        for write-protocol RE: we want to capture *user-initiated* sent frames,
//                        not the post-reload sync flood)
//   --match <substring>  Pick the Figma tab whose URL contains this substring (case-insensitive).
//                        Useful when multiple Figma tabs are open.
const argv = process.argv.slice(2);
const noReload = argv.includes('--no-reload');
const matchIdx = argv.indexOf('--match');
const urlMatch = matchIdx >= 0 ? argv[matchIdx + 1]?.toLowerCase() : null;
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--match');

const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
const res = await fetch(`${httpBase}/json`);
const targets = await res.json();
const figmaTabs = targets.filter(t => t.url?.includes('figma.com/design'));
const figmaTarget = urlMatch
  ? figmaTabs.find(t => t.url.toLowerCase().includes(urlMatch))
  : figmaTabs[0];
if (!figmaTarget) {
  console.error(`No Figma design tab${urlMatch ? ` matching "${urlMatch}"` : ''} found in Chrome`);
  if (figmaTabs.length) {
    console.error('Available Figma tabs:');
    for (const t of figmaTabs) console.error(`  ${t.title?.slice(0, 60)} — ${t.url.slice(0, 90)}`);
  }
  process.exit(1);
}

console.error(`Target: ${figmaTarget.title}`);
const ws = new WebSocket(figmaTarget.webSocketDebuggerUrl);

let id = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

const binaryFrames = [];
const CAPTURE_SECONDS = parseInt(positional[0] || '20', 10);

ws.addEventListener('open', () => {
  send('Network.enable');
  if (!noReload) {
    setTimeout(() => {
      console.error('Reloading page...');
      send('Page.reload', { ignoreCache: true });
    }, 500);
  } else {
    console.error('Attach mode (--no-reload): listening to existing session.');
  }

  setTimeout(() => {
    console.error(`\nCapture done. ${binaryFrames.length} binary frames.`);
    for (let i = 0; i < binaryFrames.length; i++) {
      const f = binaryFrames[i];
      const buf = Buffer.from(f.payloadData, 'base64');
      const dir = f.sent ? 'sent' : 'recv';
      // Index is zero-padded so lexicographic sort matches capture order — palier 1
      // (decode-frames) relies on this to replay sent mutations in the right sequence.
      const idx = String(i).padStart(4, '0');
      const path = `${DIR}/frame_${idx}_${dir}_${buf.length}b.bin`;
      writeFileSync(path, buf);

      const label = isFigWireFrame(new Uint8Array(buf)) ? ' [SCHEMA]' : '';
      console.error(`  ${path} (${buf.length} bytes) [${dir.toUpperCase()}]${label}`);
    }
    ws.close();
  }, CAPTURE_SECONDS * 1000);
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Network.webSocketFrameReceived' && msg.params.response.opcode === 2) {
    binaryFrames.push({ ...msg.params.response, requestId: msg.params.requestId });
  }
  if (msg.method === 'Network.webSocketFrameSent' && msg.params.response.opcode === 2) {
    binaryFrames.push({ ...msg.params.response, requestId: msg.params.requestId, sent: true });
  }
});

ws.addEventListener('error', (e) => console.error('WS error:', e.message));
