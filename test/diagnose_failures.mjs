#!/usr/bin/env node
// Diagnose commandsBlob and vectorNetworkBlob parse failures

import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { commandsBlobToPath, vectorNetworkBlobToPath } from '../lib/svg.mjs';

const require = createRequire(import.meta.url);
const FRAMES_DIR = '/tmp/figma_ws_frames';
const fzstd = require('fzstd');
const Schema = require(`${FRAMES_DIR}/figma_decoder.js`);

const dataFiles = readdirSync(FRAMES_DIR).filter(f => f.startsWith('page_') && f.endsWith('_data.bin'));

const cmdFailures = [];
const vnFailures = [];

for (const file of dataFiles) {
  const raw = readFileSync(`${FRAMES_DIR}/${file}`);
  if (raw.length < 100) continue;
  const bytes = new Uint8Array(raw);
  const isZstd = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  const data = isZstd ? new Uint8Array(fzstd.decompress(bytes)) : bytes;

  let decoded;
  try { decoded = Schema.decodeMessage(data); } catch { continue; }
  const blobs = decoded.blobs || [];

  for (const nc of decoded.nodeChanges || []) {
    const nid = `${nc.guid?.sessionID || 0}:${nc.guid?.localID || 0}`;

    // commandsBlob failures
    for (const fg of nc.fillGeometry || []) {
      const idx = fg.commandsBlob;
      if (typeof idx !== 'number' || !blobs[idx]?.bytes) continue;
      const b = blobs[idx].bytes;
      if (b[0] !== 0x01 || !commandsBlobToPath(b)?.startsWith('M ')) {
        cmdFailures.push({ nid, name: nc.name, len: b.length, first16: Buffer.from(b.subarray(0, 16)).toString('hex') });
      }
    }

    // vectorNetworkBlob failures
    if (nc.vectorData?.vectorNetworkBlob !== undefined) {
      const idx = nc.vectorData.vectorNetworkBlob;
      if (typeof idx !== 'number' || !blobs[idx]?.bytes) continue;
      const b = blobs[idx].bytes;
      if (b.length < 12) { vnFailures.push({ nid, name: nc.name, len: b.length, reason: 'too_short' }); continue; }

      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const vc = view.getUint32(0, true);
      const sc = view.getUint32(4, true);
      const rc = view.getUint32(8, true);
      const expectedMin = 12 + (vc * 12) + (sc * 28);

      const path = vectorNetworkBlobToPath(b);
      if (!path || vc === 0 || vc > 200 || sc > 200 || b.length < expectedMin) {
        vnFailures.push({
          nid, name: nc.name, len: b.length,
          vc, sc, rc, expectedMin,
          actualRemaining: b.length - 12 - (vc * 12) - (sc * 28),
          reason: vc > 200 ? 'too_complex' : vc === 0 ? 'no_vertices' : b.length < expectedMin ? 'too_small' : 'decode_fail',
          first32: Buffer.from(b.subarray(0, 32)).toString('hex'),
        });
      }
    }
  }
}

console.log(`=== commandsBlob failures (${cmdFailures.length}) ===\n`);
for (const f of cmdFailures) {
  console.log(`  ${f.nid} "${f.name}" (${f.len}B) first16: ${f.first16}`);
}

console.log(`\n=== vectorNetworkBlob failures (${vnFailures.length}) ===\n`);

// Group by reason
const byReason = {};
for (const f of vnFailures) {
  byReason[f.reason] = byReason[f.reason] || [];
  byReason[f.reason].push(f);
}

for (const [reason, items] of Object.entries(byReason)) {
  console.log(`--- ${reason} (${items.length}) ---`);
  for (const f of items.slice(0, 5)) {
    console.log(`  ${f.nid} "${f.name}" (${f.len}B) vc=${f.vc} sc=${f.sc} rc=${f.rc} expectedMin=${f.expectedMin} remaining=${f.actualRemaining}`);
    if (f.first32) console.log(`    hex: ${f.first32}`);
  }
  if (items.length > 5) console.log(`  ... +${items.length - 5} more`);
  console.log();
}
