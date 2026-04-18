#!/usr/bin/env node
// Figma scenegraph quality analyzer
// Heuristic detector for "designer-quality" vs "drag-and-drop poor-quality" Figma frames.
//
// Usage: figma-kiwi quality <node_id> [--json]
//
// Output: a 0-100 score, a verdict (GOOD / FAIR / POOR), the per-signal breakdown,
// and a recommended workflow for the consuming agent.

import { readFileSync, existsSync } from 'fs';

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const SG_PATH = `${DIR}/scenegraph.json`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`figma-kiwi quality — analyze a node's structural quality

Usage:
  figma-kiwi quality <node_id> [--json]

Detects how "messy" a Figma subtree is. Landing pages drawn with drag-and-drop
absolute positioning score POOR, well-organized auto-layout pages score GOOD.

When score is POOR, the consumer should:
  - NOT trust to-html parent/child nesting as section boundaries
  - Use \`figma-kiwi flatten <node_id>\` for an absolute-Y-banded listing
  - Cross-reference with a PNG render

Environment:
  FIGMA_KIWI_DIR    scenegraph.json directory (default: /tmp/figma_kiwi)
`);
  process.exit(args.length === 0 ? 1 : 0);
}

const nodeId = args[0];
const jsonOnly = args.includes('--json');

if (!existsSync(SG_PATH)) {
  console.error(`scenegraph.json not found at ${SG_PATH}`);
  console.error(`Run figma-kiwi capture-all-pages && figma-kiwi decode first.`);
  process.exit(1);
}

const sg = JSON.parse(readFileSync(SG_PATH, 'utf8'));

// ─── Build node index + children ───
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

function getChildren(nid) {
  return (childrenOf.get(nid) || []).map(c => c.nid);
}

const root = nodesById.get(nodeId);
if (!root) {
  console.error(`Node ${nodeId} not found in scenegraph.`);
  process.exit(1);
}

// ─── Helpers ───
function isAutoLayout(nc) {
  return nc?.stackMode && nc.stackMode !== 'NONE';
}
function isFrameLike(nc) {
  // Frames, instances, and component sets are layout containers
  return nc && (nc.type === 'FRAME' || nc.type === 'INSTANCE' || nc.type === 'SYMBOL' || nc.type === 'GROUP');
}
function isLeaf(nc) {
  if (!nc) return false;
  if (nc.type === 'TEXT' || nc.type === 'VECTOR' || nc.type === 'LINE' || nc.type === 'STAR') return true;
  if (nc.type === 'RECTANGLE' || nc.type === 'ELLIPSE' || nc.type === 'ROUNDED_RECTANGLE' || nc.type === 'BOOLEAN_OPERATION') return true;
  return false;
}
function getPos(nc) {
  const t = nc?.transform || {};
  return { x: t.m02 || 0, y: t.m12 || 0 };
}
function getSize(nc) {
  const s = nc?.size || {};
  return { w: s.x || 0, h: s.y || 0 };
}
function isGenericFrameName(name) {
  if (!name) return true;
  // Figma's default frame name pattern
  return /^Frame \d{3,}$/.test(name) || /^Group \d+$/.test(name) || /^Rectangle \d+$/.test(name) || /^Vector( \d+)?$/.test(name);
}

// ─── Walk and collect stats ───
const stats = {
  totalNodes: 0,
  totalFrames: 0,
  totalLeaves: 0,
  visibleLeaves: 0,
  absoluteLeaves: 0,        // leaves whose parent has no auto-layout
  genericNamedFrames: 0,    // frames matching "Frame XXXXXX" / "Group N" / etc.
  overflowingChildren: 0,   // children whose bbox extends beyond parent bbox
  comparedChildrenForOverflow: 0,
  mixedLayoutFrames: 0,     // frames with auto-layout containing >=1 ABSOLUTE child
  noLayoutNonRoot: 0,       // non-root frames with NO auto-layout AND >=2 visible children
  comparedNonRootFrames: 0,
  maxSingletonChainDepth: 0,
  totalImages: 0,           // RECTANGLE leaves with size (likely image fills)
  rootImageOrphans: 0,      // images that are direct children of root frame (suspect drag-drop)
  // Spearman: 1 - 6*Σd² / (n*(n²-1)) over the direct children of the root.
  // 1 = tree order matches Y order (well-organized), 0 = uncorrelated, -1 = inverted.
  treeYCorrelation: 1,
  // Sibling overlap: pairs of children whose bboxes overlap inside a non-auto-layout parent.
  // Each overlap is one designer who dropped something on top of something else.
  siblingOverlapPairs: 0,
  comparedSiblingPairs: 0,
};

// ─── Spearman correlation between tree order and Y order of root children ───
function computeTreeYCorrelation(rootNid) {
  const kids = (childrenOf.get(rootNid) || []).slice();
  // Filter to only visible kids that have a real position
  const filtered = kids
    .map((c, i) => ({ i, nid: c.nid, pos: c.pos, nc: nodesById.get(c.nid) }))
    .filter(k => k.nc && k.nc.visible !== false);
  if (filtered.length < 3) return 1; // not enough data
  // Tree rank (already sorted by parentIndex.position earlier in childrenOf)
  filtered.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
  const treeRank = new Map();
  filtered.forEach((k, idx) => treeRank.set(k.nid, idx));
  // Y rank — sort by absolute Y of the child
  const byY = filtered.slice().sort((a, b) => getPos(a.nc).y - getPos(b.nc).y);
  const yRank = new Map();
  byY.forEach((k, idx) => yRank.set(k.nid, idx));
  // Spearman: 1 - (6 * Σd²) / (n * (n² - 1))
  let sumDsq = 0;
  for (const k of filtered) {
    const d = treeRank.get(k.nid) - yRank.get(k.nid);
    sumDsq += d * d;
  }
  const n = filtered.length;
  return 1 - (6 * sumDsq) / (n * (n * n - 1));
}
stats.treeYCorrelation = computeTreeYCorrelation(nodeId);

function walk(nid, depth, singletonRun = 0) {
  const nc = nodesById.get(nid);
  if (!nc) return;
  if (nc.visible === false) return;
  stats.totalNodes++;

  const kids = getChildren(nid);

  if (isFrameLike(nc)) {
    stats.totalFrames++;
    if (isGenericFrameName(nc.name)) stats.genericNamedFrames++;

    // Singleton chain detection
    const visibleKids = kids.filter(k => nodesById.get(k)?.visible !== false);
    let nextSingletonRun = singletonRun;
    if (visibleKids.length === 1) {
      nextSingletonRun = singletonRun + 1;
      if (nextSingletonRun > stats.maxSingletonChainDepth) stats.maxSingletonChainDepth = nextSingletonRun;
    } else {
      nextSingletonRun = 0;
    }

    // Mixed layout: auto-layout frame with absolute children
    if (isAutoLayout(nc)) {
      const hasAbsoluteChild = visibleKids.some(k => nodesById.get(k)?.stackPositioning === 'ABSOLUTE');
      if (hasAbsoluteChild) stats.mixedLayoutFrames++;
    } else if (depth > 0 && visibleKids.length >= 2) {
      // Non-root frame with multiple children but no auto-layout
      stats.noLayoutNonRoot++;
    }
    if (depth > 0) stats.comparedNonRootFrames++;

    // Overflow detection: children outside parent bbox
    if (depth > 0) {
      const psize = getSize(nc);
      if (psize.w > 0 && psize.h > 0) {
        for (const k of visibleKids) {
          const knc = nodesById.get(k);
          if (!knc) continue;
          const kp = getPos(knc);
          const ks = getSize(knc);
          if (ks.w === 0 && ks.h === 0) continue;
          stats.comparedChildrenForOverflow++;
          // Add 2px tolerance for stroke / sub-pixel rounding
          if (kp.x < -2 || kp.y < -2 || kp.x + ks.w > psize.w + 2 || kp.y + ks.h > psize.h + 2) {
            stats.overflowingChildren++;
          }
        }
      }
    }

    // Sibling-overlap detection (only inside non-auto-layout frames — auto-layout
    // children can't legitimately overlap each other unless one is ABSOLUTE).
    if (!isAutoLayout(nc) && visibleKids.length >= 2) {
      const boxes = visibleKids
        .map(k => {
          const knc = nodesById.get(k);
          if (!knc) return null;
          const kp = getPos(knc);
          const ks = getSize(knc);
          if (ks.w <= 0 || ks.h <= 0) return null;
          return { x: kp.x, y: kp.y, w: ks.w, h: ks.h, name: knc.name || '' };
        })
        .filter(Boolean);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          stats.comparedSiblingPairs++;
          const a = boxes[i], b = boxes[j];
          // Skip near-zero overlaps (4 px tolerance) and skip cases where one
          // box fully contains the other AND covers > 90% — that's typically a
          // background fill, not a "designer dropped X on Y" situation.
          const ix0 = Math.max(a.x, b.x);
          const iy0 = Math.max(a.y, b.y);
          const ix1 = Math.min(a.x + a.w, b.x + b.w);
          const iy1 = Math.min(a.y + a.h, b.y + b.h);
          const iw = ix1 - ix0;
          const ih = iy1 - iy0;
          if (iw <= 4 || ih <= 4) continue;
          const interArea = iw * ih;
          const aArea = a.w * a.h;
          const bArea = b.w * b.h;
          const smallerArea = Math.min(aArea, bArea);
          // Containment of >90% → ignore (background/foreground stack, not drag-drop)
          if (interArea / smallerArea > 0.9) continue;
          stats.siblingOverlapPairs++;
        }
      }
    }

    for (const k of kids) walk(k, depth + 1, nextSingletonRun);
    return;
  }

  if (isLeaf(nc)) {
    stats.totalLeaves++;
    stats.visibleLeaves++;
    const parentNid = (() => {
      const pi = nc.parentIndex || {};
      const pg = pi.guid || {};
      if (pg.sessionID === undefined) return null;
      return `${pg.sessionID}:${pg.localID}`;
    })();
    const parent = parentNid ? nodesById.get(parentNid) : null;
    if (parent && !isAutoLayout(parent)) stats.absoluteLeaves++;
    if (nc.type === 'RECTANGLE' || nc.type === 'ROUNDED_RECTANGLE') {
      stats.totalImages++;
      if (depth === 1) stats.rootImageOrphans++;
    }
  }

  // Continue walking even non-leaves (e.g. INSTANCE may have children too)
  for (const k of kids) walk(k, depth + 1, 0);
}

walk(nodeId, 0, 0);

// ─── Compute ratios ───
function pct(num, den) { return den === 0 ? 0 : num / den; }

const r = {
  absoluteRatio:      pct(stats.absoluteLeaves, stats.visibleLeaves),
  genericNameRatio:   pct(stats.genericNamedFrames, stats.totalFrames),
  overflowRatio:      pct(stats.overflowingChildren, stats.comparedChildrenForOverflow),
  mixedLayoutRatio:   pct(stats.mixedLayoutFrames, stats.comparedNonRootFrames),
  noLayoutRatio:      pct(stats.noLayoutNonRoot, stats.comparedNonRootFrames),
  rootOrphanRatio:    pct(stats.rootImageOrphans, stats.totalImages),
  siblingOverlapRatio: pct(stats.siblingOverlapPairs, stats.comparedSiblingPairs),
  // Convert correlation [-1..1] to a "disorder" penalty [0..1]: 1 = perfect order, 0 = no order
  treeYDisorder:      Math.max(0, 1 - stats.treeYCorrelation), // 0 = ordered, 1 = inverted, 2 capped to 1
};

// ─── Score ───
// Weights tuned so a perfectly auto-laid-out page (recordpool components) scores ~95+,
// a partly-organized page scores 50-70, and a drag-and-drop landing page scores ~25.
// Auto-layout is the gold standard; ANY non-zero absoluteRatio gets penalized hard
// because every drag-and-drop child is a hierarchy lie waiting to mislead the agent.
let score = 100;
score -= r.absoluteRatio       * 50;
score -= r.genericNameRatio    * 20;
score -= r.overflowRatio       * 30;
score -= r.mixedLayoutRatio    * 20;
score -= r.noLayoutRatio       * 20;
score -= r.siblingOverlapRatio * 35;   // designer dropped X on Y
score -= r.treeYDisorder       * 25;   // tree order doesn't match visual order
score -= Math.min(stats.maxSingletonChainDepth, 6) * 2;

// Hard caps: any single signal that's bad enough drags the verdict down,
// even if other signals are clean.
if (r.absoluteRatio       > 0.25) score = Math.min(score, 65);
if (r.absoluteRatio       > 0.50) score = Math.min(score, 35);
if (r.genericNameRatio    > 0.50) score = Math.min(score, 70);
if (r.overflowRatio       > 0.15) score = Math.min(score, 55);
if (r.noLayoutRatio       > 0.30) score = Math.min(score, 60);
if (r.siblingOverlapRatio > 0.10) score = Math.min(score, 55);
if (r.treeYDisorder       > 0.30) score = Math.min(score, 60);
if (r.treeYDisorder       > 0.60) score = Math.min(score, 40);

score = Math.max(0, Math.min(100, Math.round(score)));

let verdict, advice;
if (score >= 80) {
  verdict = 'GOOD';
  advice = [
    'to-html parent/child nesting is reliable.',
    'Standard auto-layout → flex/grid responsive translation works.',
  ];
} else if (score >= 50) {
  verdict = 'FAIR';
  advice = [
    'to-html nesting is mostly trustworthy but verify section boundaries.',
    'For each section: cross-reference with a PNG render before committing structure.',
    'Watch for absolute-positioned children that "drift" out of their parent frame visually.',
  ];
} else {
  verdict = 'POOR';
  advice = [
    'to-html parent/child nesting is UNRELIABLE — designer used drag-and-drop, not auto-layout.',
    'Use `figma-kiwi flatten ' + nodeId + '` to get an absolute-Y-banded flat listing.',
    'Cross-reference with a PNG render via `figma_api.py image ' + nodeId + '`.',
    'Do NOT trust frame parent/child as section boundaries.',
    'Read BOTH desktop and mobile dumps and infer responsive intent from differences.',
  ];
}

if (jsonOnly) {
  console.log(JSON.stringify({ nodeId, name: root.name, score, verdict, ratios: r, stats, advice }, null, 2));
  process.exit(0);
}

// ─── Pretty print ───
const sym3 = (v, warn, bad) => v >= bad ? '✗' : (v >= warn ? '⚠' : '✓');
const pctStr = (v) => `${(v * 100).toFixed(0)}%`;

console.log(`Node: ${root.name || '(unnamed)'} (${nodeId})`);
console.log(`Score: ${score} / 100 — ${verdict}`);
console.log('');
console.log('Signals:');
console.log(`  ${sym3(r.absoluteRatio,       0.15, 0.30)} ${pctStr(r.absoluteRatio)} of visible leaves use absolute positioning (no auto-layout parent)`);
console.log(`  ${sym3(r.genericNameRatio,    0.25, 0.50)} ${pctStr(r.genericNameRatio)} of frames have generic names (Frame XXXXXX, Group N, …)`);
console.log(`  ${sym3(r.overflowRatio,       0.05, 0.15)} ${pctStr(r.overflowRatio)} of children overflow their parent's bounding box`);
console.log(`  ${sym3(r.mixedLayoutRatio,    0.05, 0.15)} ${pctStr(r.mixedLayoutRatio)} of frames mix flex children with absolute-positioned children`);
console.log(`  ${sym3(r.noLayoutRatio,       0.15, 0.30)} ${pctStr(r.noLayoutRatio)} of non-root frames have no auto-layout but multiple children`);
console.log(`  ${sym3(r.rootOrphanRatio,     0.10, 0.20)} ${pctStr(r.rootOrphanRatio)} of images are root-level orphans (suspect drag-and-drop)`);
console.log(`  ${sym3(r.siblingOverlapRatio, 0.05, 0.15)} ${pctStr(r.siblingOverlapRatio)} of sibling pairs in non-auto-layout frames overlap (designer dropped X on Y)`);
console.log(`  ${sym3(r.treeYDisorder,       0.20, 0.50)} tree↔Y order disorder = ${r.treeYDisorder.toFixed(2)} (Spearman ${stats.treeYCorrelation.toFixed(2)}; 1.0 = tree order matches Y order)`);
console.log(`  ⚠ Max singleton-chain depth: ${stats.maxSingletonChainDepth}`);
console.log('');
console.log(`Counts: ${stats.totalNodes} nodes / ${stats.totalFrames} frames / ${stats.visibleLeaves} visible leaves`);
console.log('');
console.log('Recommendation:');
for (const line of advice) console.log(`  → ${line}`);
