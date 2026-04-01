#!/usr/bin/env node
// Extract all VECTOR nodes from decoded Figma pages as individual SVG files.
//
// Usage:
//   figma-kiwi extract-svgs
//
// Environment:
//   FIGMA_KIWI_DIR   Directory with captured .bin files (default: /tmp/figma_kiwi)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { isZstdCompressed } from '../lib/kiwi.mjs';
import { extractSvgs } from '../lib/svg.mjs';

const require = createRequire(import.meta.url);
const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const DECODER_PATH = `${DIR}/figma_decoder.js`;
const OUT_DIR = `${DIR}/svgs`;

mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(DECODER_PATH)) {
  console.error('No decoder found. Run `figma-kiwi decode` first.');
  process.exit(1);
}

// Load dependencies
let fzstd;
try { fzstd = require(`${DIR}/node_modules/fzstd`); }
catch { console.error('fzstd not found. Run `figma-kiwi decode` first.'); process.exit(1); }

const Schema = require(DECODER_PATH);
const dataFiles = readdirSync(DIR).filter(f => f.startsWith('page_') && f.endsWith('_data.bin'));

const allSvgs = new Map();

for (const file of dataFiles) {
  const raw = readFileSync(`${DIR}/${file}`);
  if (raw.length < 100) continue;

  const bytes = new Uint8Array(raw);
  const data = isZstdCompressed(bytes)
    ? new Uint8Array(fzstd.decompress(bytes))
    : bytes;

  try {
    const decoded = Schema.decodeMessage(data);
    const pageSvgs = extractSvgs(decoded);
    for (const [nid, info] of pageSvgs) {
      if (!allSvgs.has(nid)) allSvgs.set(nid, info);
    }
  } catch (e) {
    console.error(`  ${file}: ${e.message?.slice(0, 80)}`);
  }
}

// Write individual SVGs + index
const index = {};
for (const [nid, info] of allSvgs) {
  const safeName = (info.name || nid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const filename = `${safeName}__${nid.replace(':', '_')}.svg`;
  writeFileSync(`${OUT_DIR}/${filename}`, info.svg);
  index[nid] = { name: info.name, type: info.type, file: filename, w: info.w, h: info.h };
}

writeFileSync(`${DIR}/svg_index.json`, JSON.stringify(index, null, 2));
console.log(`Extracted ${allSvgs.size} SVGs to ${OUT_DIR}/`);

// Summary
const icons = [...allSvgs.entries()].filter(([, v]) => /icon/i.test(v.name));
if (icons.length > 0) {
  console.log(`\nIcons: ${icons.length}`);
  for (const [nid, info] of icons.slice(0, 20)) {
    console.log(`  ${nid}: ${info.name} (${info.w.toFixed(0)}x${info.h.toFixed(0)})`);
  }
}
