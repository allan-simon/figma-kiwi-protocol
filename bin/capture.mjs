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

const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');
const res = await fetch(`${httpBase}/json`);
const targets = await res.json();
const figmaTarget = targets.find(t => t.url?.includes('figma.com/design'));
if (!figmaTarget) { console.error('No Figma design tab found in Chrome'); process.exit(1); }

console.error(`Target: ${figmaTarget.title}`);
const ws = new WebSocket(figmaTarget.webSocketDebuggerUrl);

let id = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

const binaryFrames = [];
const CAPTURE_SECONDS = parseInt(process.argv[2] || '20', 10);

ws.addEventListener('open', () => {
  send('Network.enable');
  setTimeout(() => {
    console.error('Reloading page...');
    send('Page.reload', { ignoreCache: true });
  }, 500);

  setTimeout(() => {
    console.error(`\nCapture done. ${binaryFrames.length} binary frames.`);
    for (let i = 0; i < binaryFrames.length; i++) {
      const f = binaryFrames[i];
      const buf = Buffer.from(f.payloadData, 'base64');
      const path = `${DIR}/frame_${i}_${buf.length}b.bin`;
      writeFileSync(path, buf);

      const label = isFigWireFrame(new Uint8Array(buf)) ? ' [SCHEMA]' : '';
      const dir = f.sent ? 'SENT' : 'RECV';
      console.error(`  ${path} (${buf.length} bytes) [${dir}]${label}`);
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
