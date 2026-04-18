#!/usr/bin/env node
// One-off: apply a "make it actually responsive" set of mutations to a previously
// cloned Artist Description/Footer subtree.
//
// Strategy:
//   1. Re-run cloneSubtree in dry mode to deterministically rebuild the
//      sourceGuid → cloneGuid mapping (BFS order is stable).
//   2. Look up the specific source guids by node name in the cached scenegraph.
//   3. Translate to the matching clone guids.
//   4. Build a single batched NODE_CHANGES with the responsive fixes.
//   5. Apply via FigmaSession.mutate().
//
// Usage:
//   node bin/footer-responsive-fix.mjs --clone-session 2042
//     [--source 41:1923]
//     [--scenegraph /tmp/figma_full_sync/frames_decoded.json]
//     [--dry-run]

import { readFileSync } from 'fs';
import { FigmaSession } from '../lib/session.mjs';
import { cloneSubtree } from '../lib/clone.mjs';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; }
function bool(name) { return argv.includes('--' + name); }

const cloneSessionStr = arg('clone-session');
if (!cloneSessionStr) { console.error('--clone-session <int> required'); process.exit(1); }
const cloneSession = Number(cloneSessionStr);

const sourceGuid = arg('source', '41:1923');
const scenegraph = arg('scenegraph', '/tmp/figma_full_sync/frames_decoded.json');
const handshake = arg('handshake', '/tmp/figma_handshake.json');
const kiwiDir = arg('kiwi-dir', '/tmp/figma_full_sync');
const dryRun = bool('dry-run');

// Replay cloneSubtree to rebuild the deterministic source → clone guid map
const { guidMap } = cloneSubtree({
  scenegraphPath: scenegraph,
  sourceGuid,
  newSessionID: cloneSession,
  localIDStart: 1,
});

// Find specific source guids by name in the cached scenegraph (look only inside
// the source subtree to avoid hitting unrelated identically-named nodes)
const r = JSON.parse(readFileSync(scenegraph, 'utf8'));
function gid(g){if(!g)return null;return `${g.sessionID?.__bigint||g.sessionID}:${g.localID}`}
const nodes = new Map();
const kids = new Map();
for (const f of r) for (const c of (f.decoded?.nodeChanges||[])) {
  const id = gid(c.guid); if(!id) continue;
  if (!nodes.has(id)) nodes.set(id, c);
  const pid = gid(c.parentIndex?.guid);
  if (pid) { if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(id); }
}
function descendants(rootId) {
  const out = new Set();
  const stack = [rootId];
  while (stack.length) { const id = stack.pop(); out.add(id); for (const k of (kids.get(id)||[])) stack.push(k); }
  return out;
}
const subtree = descendants(sourceGuid);
function findByName(name) {
  for (const id of subtree) {
    const n = nodes.get(id);
    if (n?.name === name) return id;
  }
  return null;
}

// Map source guids → clone guids by name
function lookup(sourceName) {
  const srcId = findByName(sourceName);
  if (!srcId) throw new Error(`Source node "${sourceName}" not found in subtree of ${sourceGuid}`);
  const clone = guidMap.get(srcId);
  if (!clone) throw new Error(`No clone mapping for "${sourceName}" (source ${srcId})`);
  return { sourceId: srcId, cloneGuid: clone };
}

const root      = lookup('Artist Description/Footer');
const left      = lookup('Frame 526');
const middle    = lookup('Frame 537');
const right     = lookup('Frame 531');
const langs     = lookup('Frame 530');     // the Languages column (only one with stackPrimarySizing=FIXED)
const headline  = lookup('JOIN THE SOUND OF ID BY RIVOLI NOW');
const image     = lookup('image 73');      // the rounded-rectangle image at the bottom of the left card
const colQuick  = lookup('Frame 528');     // Quick links column (inside middle)
const colLegal  = lookup('Frame 529');     // Legal column (inside middle)

console.error('Source → clone guid map for the responsive fix:');
for (const [label, x] of Object.entries({ root, left, middle, right, langs, headline, image, colQuick, colLegal })) {
  console.error(`  ${label.padEnd(10)} ${x.sourceId.padEnd(14)} → ${x.cloneGuid.sessionID}:${x.cloneGuid.localID}`);
}

// Build the responsive fix mutations.
//
// Strategy ("approach A" — real responsive with wrap):
//   - The root row wraps when there's not enough horizontal space, instead of
//     compressing children past readability. Wrapped rows are stacked with a
//     counter-axis gap.
//   - Each section has a sane minSize so it never collapses below a usable
//     width. Once the available width is below the sum of mins, wrap kicks in.
//   - Left + middle sections grow to fill the available space; the right
//     icon row stays its natural width.
//   - Image inside the left card stretches to fill the card's width.
//   - Left card distributes its content vertically (header at top, image at
//     bottom) instead of leaving a gap.
const mutations = [
  // 1. Root: tighter padding + spacing, plus WRAP and counter-axis settings.
  //    stackCounterSizing=Hug so the footer grows tall when rows wrap.
  {
    guid: root.cloneGuid,
    stackHorizontalPadding: 48,
    stackPaddingRight: 48,
    stackVerticalPadding: 48,
    stackPaddingBottom: 48,
    stackSpacing: 32,
    stackCounterSpacing: 32,                                     // gap between wrapped rows
    stackWrap: 'WRAP',
    stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    stackPrimaryAlignItems: 'MIN',                               // pack from the left
    stackCounterAlignItems: 'CENTER',                            // align children vertically inside their row
  },
  // 2. Left CTA card: grow + minSize so it never compresses below the headline,
  //    plus SPACE_BETWEEN distribution so its header sits at top and the image at bottom.
  {
    guid: left.cloneGuid,
    stackChildPrimaryGrow: 1,
    minSize: { value: { x: 320, y: 0 } },
    stackPrimaryAlignItems: 'SPACE_BETWEEN',
  },
  // 3. Middle 3-column block: grow + WRAP its own children so the 3 columns
  //    redistribute onto multiple rows when there's not enough room. The source
  //    used SPACE_EVENLY which lets cols overlap with negative gap once
  //    compressed — that's the bug. We replace it with a fixed gap and a real
  //    wrap so the cols flow gracefully. minSize lowered to ~widest col so the
  //    middle can shrink down to a single-column stack before the root needs to
  //    wrap the middle entirely to a new line.
  {
    guid: middle.cloneGuid,
    stackChildPrimaryGrow: 1,
    minSize: { value: { x: 200, y: 0 } },
    stackWrap: 'WRAP',
    stackPrimaryAlignItems: 'MIN',
    stackSpacing: 32,
    stackCounterSpacing: 24,
    stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  },
  // 3a/3b. Each of the 3 columns inside Frame 537 needs a min readable width
  //        so they don't compress past their natural text width and overlap.
  //        (Frame 530 / Languages already gets RESIZE_TO_FIT below at step 5.)
  {
    guid: colQuick.cloneGuid,
    minSize: { value: { x: 100, y: 0 } },
  },
  {
    guid: colLegal.cloneGuid,
    minSize: { value: { x: 160, y: 0 } },     // wider — "Terms & Conditions" needs the room
  },
  // 4. Right icon stack: keep its natural width but center it vertically when wrapped.
  {
    guid: right.cloneGuid,
    stackChildPrimaryGrow: 0,
    stackChildAlignSelf: 'CENTER',
  },
  // 5. Languages column: align with sister columns (Hug instead of Fixed).
  {
    guid: langs.cloneGuid,
    stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  },
  // 6. Headline text: wrap when the parent shrinks.
  {
    guid: headline.cloneGuid,
    textAutoResize: 'HEIGHT',
  },
  // 7. Image at the bottom of the left card: stretch to fill the card's width
  //    (left card is VERTICAL stack, so STRETCH on the child = fill its X axis).
  {
    guid: image.cloneGuid,
    stackChildAlignSelf: 'STRETCH',
  },
];

console.error(`\nBatched ${mutations.length} mutations`);
if (dryRun) {
  console.error(JSON.stringify(mutations, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  process.exit(0);
}

console.error(`Connecting to ${handshake}...`);
const session = await FigmaSession.connect({ handshakePath: handshake, kiwiDir });
console.error(`✓ joined sessionID=${session.sessionID}`);

try {
  const ack = await session.mutate(mutations);
  console.error(`✓ acked at ackID=${ack.ackID} (${ack.nodeChanges?.length || 0} echoed back)`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 2;
} finally {
  await session.close();
}
