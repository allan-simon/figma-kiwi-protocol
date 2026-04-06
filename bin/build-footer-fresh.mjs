#!/usr/bin/env node
// Build a fresh "Footer" component from scratch with a properly responsive
// structure. No legacy patches, no whack-a-mole — just the structure I would
// write if I were authoring this in CSS.
//
// This is a wireframe: coloured FRAMES as content placeholders, no TEXT (text
// nodes are non-trivial to author from scratch — fonts, line metrics, glyph
// blobs). Once the responsive behaviour is validated, real content can be
// added by cloning leaf nodes from the original Footer.
//
// Usage:
//   node bin/build-footer-fresh.mjs [--parent 0:1] [--position "(RQDkRR"] [--dry-run]

import { FigmaSession } from '../lib/session.mjs';
import { FigmaBuilder } from '../lib/builder.mjs';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; }
function bool(name) { return argv.includes('--' + name); }

const parentArg = arg('parent', '0:1');
const position = arg('position', '!');
const dryRun = bool('dry-run');

const [parentSession, parentLocal] = parentArg.split(':').map(Number);
const PARENT = { guid: { sessionID: parentSession, localID: parentLocal }, position };

console.error(`Building fresh Footer under parent ${parentArg}`);

console.error('Connecting...');
const session = await FigmaSession.connect();
console.error(`✓ joined sessionID=${session.sessionID}`);

const b = new FigmaBuilder({ sessionID: session.sessionID });

// Colour palette for the wireframe placeholders. Distinctive enough that each
// section is unmistakable when you see the rendered footer.
const COLORS = {
  bg:        [0.07, 0.07, 0.10],   // dark navy footer background
  cardBg:    [0.13, 0.13, 0.18],   // slightly lighter card surface
  accent:    [0.95, 0.30, 0.20],   // CTA accent
  textPlaceholder: [0.85, 0.85, 0.90, 0.6],
  iconPlaceholder: [0.95, 0.95, 1.0, 0.9],
};

// ============================================================================
// ROOT — the footer itself.
// HORIZONTAL stack with WRAP so that as the parent narrows, sections flow onto
// new lines instead of compressing past readability. Width is fixed (designer-
// set) but height is Hug so it grows tall when wrap kicks in.
// ============================================================================
// Suffix the root name with a wall-clock timestamp so successive runs are easy
// to tell apart in the layers panel — newest one is the highest minute.
const ts = new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
const root = b.frame({
  name: `Footer (rebuilt ${ts})`,
  parent: PARENT,
  size: { x: 1200, y: 320 },
  fill: COLORS.bg,
  stackMode: 'HORIZONTAL',
  stackWrap: 'WRAP',
  stackPrimarySizing: 'FIXED',
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackHorizontalPadding: 48,
  stackPaddingRight: 48,
  stackVerticalPadding: 48,
  stackPaddingBottom: 48,
  stackSpacing: 32,
  stackCounterSpacing: 32,
  stackPrimaryAlignItems: 'MIN',
  stackCounterAlignItems: 'MIN',
});

// ============================================================================
// SECTION 1 — Left CTA card.
// VERTICAL stack, growable, with a min-width so it never collapses past the
// headline. Contains a coloured header band and a CTA button placeholder.
// ============================================================================
const leftCard = b.frame({
  name: 'CTA Card',
  parent: root,
  size: { x: 320, y: 220 },
  fill: COLORS.cardBg,
  cornerRadius: 12,
  stackMode: 'VERTICAL',
  stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackCounterSizing: 'FIXED',
  stackHorizontalPadding: 24,
  stackPaddingRight: 24,
  stackVerticalPadding: 24,
  stackPaddingBottom: 24,
  stackSpacing: 16,
  stackChildPrimaryGrow: 1,
  minSize: { x: 320, y: 0 },
});

// CTA headline placeholder
b.rect({
  name: 'Headline',
  parent: leftCard,
  size: { x: 200, y: 20 },
  fill: COLORS.textPlaceholder,
  cornerRadius: 4,
  stackChildAlignSelf: 'STRETCH',
});
// Subtitle placeholder
b.rect({
  name: 'Subtitle',
  parent: leftCard,
  size: { x: 200, y: 12 },
  fill: COLORS.textPlaceholder,
  cornerRadius: 4,
  stackChildAlignSelf: 'STRETCH',
});
// CTA button placeholder
b.rect({
  name: 'CTA Button',
  parent: leftCard,
  size: { x: 140, y: 40 },
  fill: COLORS.accent,
  cornerRadius: 8,
});
// Image placeholder — fills the card's width
b.rect({
  name: 'Image',
  parent: leftCard,
  size: { x: 200, y: 60 },
  fill: COLORS.cardBg,
  cornerRadius: 8,
  stackChildAlignSelf: 'STRETCH',
});

// ============================================================================
// SECTION 2 — Middle social row (matches the source Footer order: CTA | Social | Links).
// HORIZONTAL stack of icon placeholders. Hug width so it stays its natural
// size. Centered on its row when wrapped.
// ============================================================================
const social = b.frame({
  name: 'Social',
  parent: root,
  size: { x: 240, y: 40 },
  fill: [0, 0, 0, 0],
  stackMode: 'HORIZONTAL',
  stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackSpacing: 16,
  stackPrimaryAlignItems: 'MIN',
  stackCounterAlignItems: 'CENTER',
  stackChildPrimaryGrow: 0,
  stackChildAlignSelf: 'CENTER',
});

const ICONS = ['Instagram', 'Spotify', 'Tiktok', 'X', 'Soundcloud'];
for (const icon of ICONS) {
  b.rect({
    name: icon,
    parent: social,
    size: { x: 32, y: 32 },
    fill: COLORS.iconPlaceholder,
    cornerRadius: 8,
  });
}

// ============================================================================
// SECTION 3 — Right 3-column block.
// HORIZONTAL stack with its OWN wrap so that when there's not enough room for
// 3 cols, they flow onto multiple rows. Growable in the parent.
// ============================================================================
const middle = b.frame({
  name: 'Links',
  parent: root,
  size: { x: 480, y: 220 },
  fill: [0, 0, 0, 0],
  stackMode: 'HORIZONTAL',
  stackWrap: 'WRAP',
  stackPrimarySizing: 'FIXED',
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackSpacing: 32,
  stackCounterSpacing: 24,
  stackPrimaryAlignItems: 'MIN',
  stackCounterAlignItems: 'MIN',
  stackChildPrimaryGrow: 1,
  minSize: { x: 280, y: 0 },
});

// 3 columns. Each is a VERTICAL stack of label placeholders. Hug height,
// fixed natural width with a min so it doesn't compress.
function buildColumn(name, labelCount) {
  const col = b.frame({
    name,
    parent: middle,
    size: { x: 120, y: 180 },
    fill: [0, 0, 0, 0],
    stackMode: 'VERTICAL',
    stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    stackSpacing: 12,
    minSize: { x: 100, y: 0 },
  });
  // Heading placeholder
  b.rect({
    name: `${name} heading`,
    parent: col,
    size: { x: 100, y: 14 },
    fill: COLORS.textPlaceholder,
    cornerRadius: 3,
  });
  // Link placeholders
  for (let i = 0; i < labelCount; i++) {
    b.rect({
      name: `${name} link ${i + 1}`,
      parent: col,
      size: { x: 80 + (i * 6) % 30, y: 10 },
      fill: COLORS.textPlaceholder,
      cornerRadius: 2,
    });
  }
  return col;
}

buildColumn('Quick links', 6);
buildColumn('Legal', 6);
buildColumn('Languages', 5);

const nodeChanges = b.build();
console.error(`Built ${nodeChanges.length} nodes:`);
for (const c of nodeChanges) {
  console.error(`  ${c.guid.sessionID}:${c.guid.localID}  ${c.type.padEnd(18)}  "${c.name}"`);
}

if (dryRun) { process.exit(0); }

console.error(`\nSending ${nodeChanges.length} nodeChanges in one mutation...`);
try {
  const ack = await session.mutate(nodeChanges, { timeoutMs: 15000 });
  console.error(`✓ acked at ackID=${ack.ackID} (${ack.nodeChanges?.length || 0} echoed back)`);
  console.error(`\nNew root: ${root.guid.sessionID}:${root.guid.localID} — search "Footer (rebuilt)" in Figma`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 2;
} finally {
  await session.close();
}
