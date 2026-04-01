#!/usr/bin/env node
// Capture all pages from a Figma file via CDP.
// Discovers pages via REST API, then navigates to each and captures WS frames.
//
// Usage:
//   figma-kiwi capture-all-pages
//
// Environment:
//   CDP_WS_URL       Chrome DevTools WebSocket URL (required)
//   FIGMA_TOKEN      Figma personal access token (required)
//   FIGMA_FILE_KEY   Figma file key from URL (required)
//   FIGMA_KIWI_DIR   Output directory (default: /tmp/figma_kiwi)

import { writeFileSync } from 'fs';
import { isFigWireFrame } from '../lib/kiwi.mjs';

const wsUrl = process.env.CDP_WS_URL;
const token = process.env.FIGMA_TOKEN;
const fileKey = process.env.FIGMA_FILE_KEY;
const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';

if (!wsUrl) { console.error('Set CDP_WS_URL'); process.exit(1); }
if (!token) { console.error('Set FIGMA_TOKEN'); process.exit(1); }
if (!fileKey) { console.error('Set FIGMA_FILE_KEY'); process.exit(1); }

// Discover pages via REST API
async function fetchPages() {
  console.error('Fetching page list from Figma API...');
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
    headers: { 'X-Figma-Token': token },
  });
  if (!res.ok) {
    console.error(`API error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = await res.json();
  return (data.document?.children || [])
    .filter(c => c.type === 'CANVAS')
    .map(c => ({ id: c.id, name: c.name }));
}

const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/.*/, '');

async function getTargetWsUrl() {
  const res = await fetch(`${httpBase}/json`);
  const targets = await res.json();
  const t = targets.find(t => t.url?.includes('figma.com/design'));
  if (!t) throw new Error('No Figma design tab found');
  return t.webSocketDebuggerUrl;
}

async function capturePage(pageId, pageName) {
  console.error(`\n--- ${pageName} (${pageId}) ---`);
  const targetWsUrl = await getTargetWsUrl();
  const ws = new WebSocket(targetWsUrl);
  let id = 1;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

  return new Promise((resolve) => {
    const binaryFrames = [];

    ws.addEventListener('open', () => {
      send('Network.enable');
      const url = `https://www.figma.com/design/${fileKey}/?node-id=${pageId.replace(':', '-')}&p=f`;
      send('Page.navigate', { url });

      setTimeout(() => {
        let schemaFrame = null;
        const dataBuffers = [];

        for (const f of binaryFrames) {
          const buf = Buffer.from(f.payloadData, 'base64');
          if (isFigWireFrame(new Uint8Array(buf))) {
            schemaFrame = buf;
          } else {
            dataBuffers.push(buf);
          }
        }

        dataBuffers.sort((a, b) => b.length - a.length);

        if (dataBuffers.length > 0 && schemaFrame) {
          const safeId = pageId.replace(':', '_');
          writeFileSync(`${DIR}/page_${safeId}_data.bin`, dataBuffers[0]);
          writeFileSync(`${DIR}/page_${safeId}_schema.bin`, schemaFrame);
          console.error(`  Data: ${dataBuffers[0].length}B, Schema: ${schemaFrame.length}B`);
        } else {
          console.error(`  WARNING: Missing data or schema`);
        }

        ws.close();
        resolve();
      }, 12000);
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Network.webSocketFrameReceived' && msg.params.response.opcode === 2) {
        binaryFrames.push(msg.params.response);
      }
    });

    ws.addEventListener('error', (e) => console.error('  WS error:', e.message));
  });
}

const pages = await fetchPages();
console.error(`Found ${pages.length} pages`);
for (const page of pages) {
  await capturePage(page.id, page.name);
  await new Promise(r => setTimeout(r, 2000));
}
console.error('\nAll pages captured. Run: figma-kiwi decode');
