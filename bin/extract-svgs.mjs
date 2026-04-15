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
import { extractSvgs, composeSvgIcon } from '../lib/svg.mjs';
import { nodeId, buildTree, mergePages, decodePage } from '../lib/scenegraph.mjs';

const require = createRequire(import.meta.url);
const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const DECODER_PATH = `${DIR}/figma_decoder.js`;
const OUT_DIR = `${DIR}/svgs`;

// --compose <node_id>: compose an inline-ready SVG icon from a SYMBOL and its children
const composeIdx = process.argv.indexOf('--compose');
if (composeIdx !== -1) {
  const targetNid = process.argv[composeIdx + 1];
  if (!targetNid) {
    console.error('Usage: figma-kiwi extract-svgs --compose <node_id>');
    console.error('  Compose SYMBOL + children into a single inline-ready <svg>');
    process.exit(1);
  }

  // Need scenegraph.json (from decode) and svg_index + svg files (from extract-svgs)
  const sgPath = `${DIR}/scenegraph.json`;
  const svgIndexPath = `${DIR}/svg_index.json`;
  if (!existsSync(sgPath)) { console.error('No scenegraph.json found. Run `figma-kiwi decode` first.'); process.exit(1); }
  if (!existsSync(svgIndexPath)) { console.error('No svg_index.json found. Run `figma-kiwi extract-svgs` first (without --compose).'); process.exit(1); }

  const sg = JSON.parse(readFileSync(sgPath, 'utf8'));
  const svgIndex = JSON.parse(readFileSync(svgIndexPath, 'utf8'));
  const tree = buildTree(sg);

  const treeNode = tree.get(targetNid);
  if (!treeNode) { console.error(`Node ${targetNid} not found`); process.exit(1); }

  const symbolNc = treeNode.raw;
  const childNodes = treeNode.children.map(childId => {
    const childTreeNode = tree.get(childId);
    if (!childTreeNode) return null;
    const nc = childTreeNode.raw;
    // Pass the full 2x3 affine so composeSvgIcon can emit matrix(...) for
    // scaled/rotated/mirrored children (e.g. horizontally-flipped icons).
    return { node: nc, transform: nc.transform || {} };
  }).filter(Boolean);

  function getSvgFile(nid) {
    const entry = svgIndex[nid];
    if (!entry?.file) return null;
    const p = `${OUT_DIR}/${entry.file}`;
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  const svg = composeSvgIcon(symbolNc, childNodes, getSvgFile);
  if (!svg) { console.error(`No SVG paths found for ${targetNid} (${treeNode.name})`); process.exit(1); }

  console.log(svg);
  process.exit(0);
}

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

// FRAME/INSTANCE composition pass — iconify-style containers hide the glyph
// in a child VECTOR while the FRAME itself has a hidden bounding-box fill.
// Rewrite those container entries to a composed SVG so lookups by the
// container id return the rendered icon, not an empty/background rect.
const sgPath = `${DIR}/scenegraph.json`;
let composedCount = 0;
if (existsSync(sgPath)) {
  const sg = JSON.parse(readFileSync(sgPath, 'utf8'));
  const tree = buildTree(sg);

  const getSvgFile = (nid) => {
    const entry = index[nid];
    if (!entry?.file) return null;
    const p = `${OUT_DIR}/${entry.file}`;
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };

  for (const [nid, treeNode] of tree) {
    if (treeNode.type !== 'FRAME' && treeNode.type !== 'INSTANCE') continue;
    if (!treeNode.children?.length) continue;

    const hasVectorChild = treeNode.children.some(cid => {
      const c = tree.get(cid);
      return c && c.type === 'VECTOR' && index[cid];
    });
    if (!hasVectorChild) continue;

    const containerNc = treeNode.raw;
    const childNodes = treeNode.children.map(cid => {
      const c = tree.get(cid);
      if (!c) return null;
      // Full 2x3 affine so composeSvgIcon can preserve scale/rotate/mirror.
      return { node: c.raw, transform: c.raw.transform || {} };
    }).filter(Boolean);

    const svg = composeSvgIcon(containerNc, childNodes, getSvgFile);
    if (!svg) continue;

    const existingFile = index[nid]?.file;
    const safeName = (treeNode.name || nid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const filename = existingFile || `${safeName}__${nid.replace(':', '_')}.svg`;
    writeFileSync(`${OUT_DIR}/${filename}`, svg);
    const size = containerNc.size || {};
    index[nid] = {
      name: treeNode.name,
      type: treeNode.type,
      file: filename,
      w: size.x || 0,
      h: size.y || 0,
      composed: true,
    };
    composedCount++;
  }
}

writeFileSync(`${DIR}/svg_index.json`, JSON.stringify(index, null, 2));
console.log(`Extracted ${allSvgs.size} SVGs to ${OUT_DIR}/ (composed ${composedCount} FRAME/INSTANCE containers)`);

// Summary
const icons = [...allSvgs.entries()].filter(([, v]) => /icon/i.test(v.name));
if (icons.length > 0) {
  console.log(`\nIcons: ${icons.length}`);
  for (const [nid, info] of icons.slice(0, 20)) {
    console.log(`  ${nid}: ${info.name} (${info.w.toFixed(0)}x${info.h.toFixed(0)})`);
  }
}
