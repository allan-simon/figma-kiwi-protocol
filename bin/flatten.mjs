#!/usr/bin/env node
// Flatten a Figma subtree into absolute-Y-banded HTML.
// For "POOR quality" landing pages where parent/child nesting is unreliable.
//
// Walks the tree, computes the absolute (cumulative) position of every leaf,
// sorts leaves by Y, then auto-detects horizontal "bands" by looking for
// vertical gaps. Each band becomes a <y-band> element in the output, and
// every leaf inside it carries data-x / data-y / data-w / data-h plus the
// real text/image URL.
//
// Usage: figma-kiwi flatten <node_id> [--gap N] [--out file.html]
//   --gap N   minimum vertical gap (px) between leaves to start a new band (default 60)
//   --out F   write to file F (default stdout)

import { readFileSync, writeFileSync, existsSync } from 'fs';

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const SG_PATH = `${DIR}/scenegraph.json`;
const IMG_MAP_PATH = `${DIR}/image_mapping.json`;
const HASHES_PATH = `${DIR}/all_image_hashes.json`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`figma-kiwi flatten — Y-banded flat listing of a Figma subtree

Usage:
  figma-kiwi flatten <node_id> [--gap N] [--out file.html]

Used when \`figma-kiwi quality <node_id>\` reports POOR quality. Walks the
subtree, computes absolute positions, and groups leaves into horizontal
bands separated by vertical gaps (default 60 px). Each band's elements are
listed with their real x/y/w/h and content (text / image URL / SVG hint).

Options:
  --gap N    vertical gap (px) that triggers a new band (default 60)
  --out F    output file (default stdout)
`);
  process.exit(args.length === 0 ? 1 : 0);
}

const nodeId = args[0];
let gap = 60;
let outFile = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--gap') gap = parseInt(args[++i], 10);
  else if (args[i] === '--out') outFile = args[++i];
}

if (!existsSync(SG_PATH)) {
  console.error(`scenegraph.json not found at ${SG_PATH}`);
  process.exit(1);
}

const sg = JSON.parse(readFileSync(SG_PATH, 'utf8'));
const imgMap = existsSync(IMG_MAP_PATH) ? JSON.parse(readFileSync(IMG_MAP_PATH, 'utf8')) : {};
const hashIndex = existsSync(HASHES_PATH) ? JSON.parse(readFileSync(HASHES_PATH, 'utf8')) : [];

// ─── Index ───
const nodesById = new Map();
const childrenOf = new Map();
for (const nc of sg.nodeChanges || []) {
  const g = nc.guid || {};
  const nid = `${g.sessionID || 0}:${g.localID || 0}`;
  nodesById.set(nid, nc);
  const pi = nc.parentIndex || {};
  const pg = pi.guid || {};
  if (pg.sessionID !== undefined) {
    const pid = `${pg.sessionID}:${pg.localID}`;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push({ pos: pi.position || '', nid });
  }
}
for (const [, c] of childrenOf) c.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));

const root = nodesById.get(nodeId);
if (!root) {
  console.error(`Node ${nodeId} not found.`);
  process.exit(1);
}

function getChildren(nid) { return (childrenOf.get(nid) || []).map(c => c.nid); }
function getPos(nc) { const t = nc?.transform || {}; return { x: t.m02 || 0, y: t.m12 || 0 }; }
function getSize(nc) { const s = nc?.size || {}; return { w: s.x || 0, h: s.y || 0 }; }
function isLeaf(nc) {
  if (!nc) return false;
  if (['TEXT', 'VECTOR', 'LINE', 'STAR', 'RECTANGLE', 'ELLIPSE', 'ROUNDED_RECTANGLE', 'BOOLEAN_OPERATION'].includes(nc.type)) return true;
  return false;
}
function getImageUrl(nid) {
  for (const h of hashIndex) {
    if (h.nodes && h.nodes.includes(nid)) {
      const info = imgMap[h.hash];
      if (info?.url) return info.url;
    }
  }
  return null;
}

// ─── Walk + collect leaves with absolute positions ───
const rootPos = getPos(root);
const leaves = [];

// Z is a global counter that increments in document order. Lower Z = earlier
// in the tree = rendered first = visually behind. Higher Z = later = on top.
let zCounter = 0;

function walk(nid, parentX, parentY) {
  const nc = nodesById.get(nid);
  if (!nc || nc.visible === false) return;
  const p = getPos(nc);
  const ax = parentX + p.x;
  const ay = parentY + p.y;
  const s = getSize(nc);

  if (isLeaf(nc)) {
    const leaf = {
      nid,
      type: nc.type,
      name: nc.name || '',
      x: Math.round(ax),
      y: Math.round(ay),
      w: Math.round(s.w),
      h: Math.round(s.h),
      z: zCounter++,
      text: nc.type === 'TEXT' ? (nc.textData?.characters || nc.characters || '') : null,
      imgUrl: nc.type === 'RECTANGLE' || nc.type === 'ROUNDED_RECTANGLE' ? getImageUrl(nid) : null,
    };
    leaves.push(leaf);
  }

  for (const k of getChildren(nid)) walk(k, ax, ay);
}

walk(nodeId, -rootPos.x, -rootPos.y);

if (leaves.length === 0) {
  console.error(`No visible leaves found in ${nodeId}.`);
  process.exit(1);
}

// ─── Sort by Y then X ───
leaves.sort((a, b) => a.y - b.y || a.x - b.x);

// ─── Detect bands by vertical gap ───
const bands = [];
let current = { y0: leaves[0].y, y1: leaves[0].y + leaves[0].h, leaves: [leaves[0]] };
for (let i = 1; i < leaves.length; i++) {
  const l = leaves[i];
  if (l.y - current.y1 > gap) {
    bands.push(current);
    current = { y0: l.y, y1: l.y + l.h, leaves: [l] };
  } else {
    if (l.y + l.h > current.y1) current.y1 = l.y + l.h;
    current.leaves.push(l);
  }
}
bands.push(current);

// ─── Render ───
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = [];
lines.push('<!DOCTYPE html>');
lines.push('<html lang="en"><head><meta charset="UTF-8">');
lines.push(`<title>Flat: ${esc(root.name || nodeId)}</title>`);
lines.push('<style>body{font-family:system-ui,sans-serif;margin:0;background:#0a0a0a;color:#eaeaea}y-band{display:block;border-top:2px solid #3dbbff;padding:18px 24px;margin:0}y-band:first-of-type{border-top:none}y-band > header{font-size:11px;color:#3dbbff;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}leaf{display:block;font-size:13px;padding:6px 0;border-bottom:1px dotted #2a2a2a}.coord{color:#888;font-family:ui-monospace,monospace;font-size:11px;margin-right:10px}.txt{color:#fff}.img{color:#fbbf24}.vec{color:#a78bfa}.name{color:#666;font-size:11px;margin-left:10px}img{display:block;max-width:200px;max-height:120px;margin-top:6px;border:1px solid #333}</style>');
lines.push('</head><body>');
lines.push(`<h1 style="padding:24px;margin:0;font-size:18px;color:#3dbbff">Flat dump — ${esc(root.name || '')} (${nodeId})</h1>`);
lines.push(`<p style="padding:0 24px 24px;color:#888;font-size:12px">${bands.length} bands · ${leaves.length} leaves · gap ${gap}px</p>`);

// Helper: cluster leaves whose bboxes overlap into <overlap-group>s.
// Two leaves are in the same group if their bboxes intersect by more than 4×4 px.
// Within each group, sort by Z (back to front).
function clusterByOverlap(leaves) {
  const parent = leaves.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      const ix0 = Math.max(a.x, b.x), iy0 = Math.max(a.y, b.y);
      const ix1 = Math.min(a.x + a.w, b.x + b.w), iy1 = Math.min(a.y + a.h, b.y + b.h);
      if (ix1 - ix0 > 4 && iy1 - iy0 > 4) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < leaves.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(leaves[i]);
  }
  // Convert to array of clusters, sort each cluster by Z (back→front)
  return [...groups.values()].map(g => g.sort((a, b) => a.z - b.z));
}

function renderLeaf(l, indent) {
  const cls = l.text != null ? 'txt' : (l.imgUrl ? 'img' : 'vec');
  let body = '';
  if (l.text != null) body = `<span class="txt">"${esc(l.text)}"</span>`;
  else if (l.imgUrl) body = `<span class="img">IMAGE</span><img src="${esc(l.imgUrl)}" alt="${esc(l.name)}" loading="lazy">`;
  else body = `<span class="vec">${esc(l.type)}</span>`;
  return `${indent}<leaf class="${cls}" data-x="${l.x}" data-y="${l.y}" data-w="${l.w}" data-h="${l.h}" data-z="${l.z}"><span class="coord">x:${l.x} y:${l.y} w:${l.w} h:${l.h} z:${l.z}</span>${body}<span class="name">${esc(l.name)}</span></leaf>`;
}

for (let bi = 0; bi < bands.length; bi++) {
  const b = bands[bi];
  lines.push(`<y-band data-band="${bi + 1}" data-y="${b.y0}" data-h="${b.y1 - b.y0}">`);
  lines.push(`  <header>Band ${bi + 1} — Y ${b.y0}…${b.y1} (${b.y1 - b.y0}px tall, ${b.leaves.length} leaves)</header>`);
  // Cluster overlapping leaves, then sort clusters by left-most X for reading order
  const clusters = clusterByOverlap(b.leaves);
  clusters.sort((a, b) => Math.min(...a.map(l => l.x)) - Math.min(...b.map(l => l.x)));
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      lines.push(renderLeaf(cluster[0], '  '));
    } else {
      // Compute cluster bbox for the group element
      const x = Math.min(...cluster.map(l => l.x));
      const y = Math.min(...cluster.map(l => l.y));
      const x2 = Math.max(...cluster.map(l => l.x + l.w));
      const y2 = Math.max(...cluster.map(l => l.y + l.h));
      lines.push(`  <overlap-group data-x="${x}" data-y="${y}" data-w="${x2 - x}" data-h="${y2 - y}" data-count="${cluster.length}">`);
      lines.push(`    <header>↳ overlap-group ${cluster.length} leaves stacked at x:${x} y:${y} (${x2 - x}×${y2 - y}px) — sorted back→front by Z</header>`);
      for (const l of cluster) lines.push(renderLeaf(l, '    '));
      lines.push(`  </overlap-group>`);
    }
  }
  lines.push('</y-band>');
}
lines.push('</body></html>');

const html = lines.join('\n');
if (outFile) {
  writeFileSync(outFile, html);
  console.error(`Written to ${outFile} — ${bands.length} bands, ${leaves.length} leaves`);
} else {
  process.stdout.write(html);
}
