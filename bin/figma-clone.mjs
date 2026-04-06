#!/usr/bin/env node
// figma-clone — deep-clone a subtree from a cached scenegraph into the live file.
//
// Usage:
//   node bin/figma-clone.mjs <sourceGuid>
//     [--scenegraph /tmp/figma_full_sync/frames_decoded.json]
//     [--handshake /tmp/figma_handshake.json]
//     [--kiwi-dir /tmp/figma_full_sync]
//     [--name-suffix " (clone)"]
//     [--keep-derived]                  send derivedTextData/derivedSymbolData verbatim too
//     [--dry-run]                       compute the clone but don't send

import { FigmaSession } from '../lib/session.mjs';
import { cloneSubtree } from '../lib/clone.mjs';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; }
function bool(name) { return argv.includes('--' + name); }

const sourceGuid = argv.find(a => /^\d+:\d+$/.test(a));
if (!sourceGuid) {
  console.error('usage: figma-clone <sourceGuid> [--scenegraph PATH] [--handshake PATH] [--name-suffix " (clone)"] [--keep-derived] [--dry-run]');
  process.exit(1);
}
const scenegraph = arg('scenegraph', '/tmp/figma_full_sync/frames_decoded.json');
const handshake  = arg('handshake', '/tmp/figma_handshake.json');
const kiwiDir    = arg('kiwi-dir', '/tmp/figma_full_sync');
const nameSuffix = arg('name-suffix', ' (clone)');
const keepDerived = bool('keep-derived');
const dryRun = bool('dry-run');

console.error(`Cloning subtree rooted at ${sourceGuid}`);
console.error(`  scenegraph: ${scenegraph}`);

if (dryRun) {
  // Use sessionID 9999 as a placeholder so we can compute and display stats
  // without opening a connection
  const { nodeChanges, stats } = cloneSubtree({
    scenegraphPath: scenegraph,
    sourceGuid,
    newSessionID: 9999,
    stripDerived: !keepDerived,
  });
  console.error(`Would create ${stats.count} nodes:`);
  for (const [t, n] of Object.entries(stats.types).sort((a,b)=>b[1]-a[1])) {
    console.error(`  ${t}: ${n}`);
  }
  console.error(`Blob refs: ${stats.blobRefsKept} kept, ${stats.blobRefsDropped} dropped (with stripDerived=${!keepDerived})`);
  if (stats.blobRefsKept > 0) {
    console.error(`⚠ ${stats.blobRefsKept} blob refs are kept — this strategy ignores them, which means VECTOR/strokeGeometry shapes may not render. If visuals fail, we'll need a blob-copying pass.`);
  }
  // Sample the first cloned change for sanity
  console.error(`\nFirst cloned change:`);
  console.error(`  guid: ${JSON.stringify(nodeChanges[0].guid)}`);
  console.error(`  type: ${nodeChanges[0].type}`);
  console.error(`  name: ${nodeChanges[0].name}`);
  console.error(`  fields: ${Object.keys(nodeChanges[0]).join(', ')}`);
  process.exit(0);
}

console.error(`Connecting via ${handshake}...`);
const session = await FigmaSession.connect({ handshakePath: handshake, kiwiDir });
console.error(`✓ joined sessionID=${session.sessionID}`);

const { nodeChanges, blobs, stats, guidMap } = cloneSubtree({
  scenegraphPath: scenegraph,
  sourceGuid,
  newSessionID: session.sessionID,
  nameSuffix,
  stripDerived: !keepDerived,
});

console.error(`Built ${stats.count} cloned nodeChanges:`);
for (const [t, n] of Object.entries(stats.types).sort((a,b)=>b[1]-a[1])) {
  console.error(`  ${t}: ${n}`);
}
console.error(`Blob refs: ${stats.blobRefsKept} copied (${stats.blobsCopied} unique), ${stats.blobRefsDropped} dropped via stripDerived`);

const newRootGuid = guidMap.get(sourceGuid);
console.error(`\nNew root will be ${newRootGuid.sessionID}:${newRootGuid.localID}`);

console.error(`Sending mutation (${stats.count} nodeChanges + ${blobs.length} blobs in one message)...`);
try {
  const ack = await session.mutate(nodeChanges, { timeoutMs: 30000, blobs });
  console.error(`✓ acked at ackID=${ack.ackID}`);
  if (ack.nodeChanges?.length) {
    console.error(`  server echoed ${ack.nodeChanges.length} nodeChanges back`);
  }
} catch (e) {
  console.error(`✗ mutation failed: ${e.message}`);
  process.exitCode = 2;
}
await session.close();
