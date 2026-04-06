// Deep-clone a subtree of nodes from a cached scenegraph into a list of new
// nodeChanges that can be sent through FigmaSession.mutate() to create an
// independent copy in the live file.
//
// Strategy: optimistic — strip `derivedTextData` and `derivedSymbolData` from
// every cloned node, on the bet that Figma's server recomputes them from the
// raw fields (textData, fontName, fillPaints, …). This eliminates ~93% of the
// blob references in a typical text-heavy subtree. If Figma renders the clones
// without the derived fields, no blob copying is needed at all.
//
// What we still need to handle:
//   - Generate new guids in our session's namespace
//   - Remap parentIndex.guid for every descendant (root keeps original parent)
//   - Set phase: "CREATED" so the server treats each node as a brand-new node
//   - Revive __bigint and __bytes wrappers from frames_decoded.json into native
//     BigInt and Uint8Array, since Schema.encodeMessage expects native types
//
// Out of scope for this first cut:
//   - commandsBlob/vectorNetworkBlob index remapping (TODO if visuals fail)
//   - parentIndex.position rebalancing (we reuse the source's position)
//   - Smart name suffixing beyond a single " (clone)" tag

import { readFileSync } from 'fs';

const STRIP_FIELDS = new Set(['derivedTextData', 'derivedSymbolData']);

function gidStr(g) {
  if (!g) return null;
  const s = g.sessionID?.__bigint || g.sessionID;
  return `${s}:${g.localID}`;
}

/**
 * Bring our serialized scenegraph back to a shape Schema.encodeMessage can consume.
 * Our frames_decoded.json wraps BigInt as {__bigint:"..."} and Uint8Array as
 * {__bytes:"<base64>", len:N}; both must be unwrapped before encoding.
 */
function revive(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if ('__bigint' in v && Object.keys(v).length === 1) return BigInt(v.__bigint);
  if ('__bytes' in v) return new Uint8Array(Buffer.from(v.__bytes, 'base64'));
  if (Array.isArray(v)) return v.map(revive);
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = revive(val);
  return out;
}

/**
 * Walk all descendants of `rootId` in the cached scenegraph and return a list
 * of nodeChanges with new guids, remapped parents, phase=CREATED, and the
 * derived* fields stripped.
 *
 * @param {Object} opts
 * @param {string} opts.scenegraphPath  path to a frames_decoded.json that
 *                                      contains a full file sync (a recv
 *                                      NODE_CHANGES with phase=CREATED on
 *                                      every node — that's what `capture` with
 *                                      reload produces)
 * @param {string} opts.sourceGuid      "sessionID:localID" of the subtree root
 * @param {number} opts.newSessionID    our connected session ID, used as the
 *                                      namespace prefix for all new guids
 * @param {number} [opts.localIDStart]  first new localID to allocate (default 1)
 * @param {string} [opts.nameSuffix]    appended to the root node's name (default " (clone)")
 * @param {boolean} [opts.stripDerived] strip derivedTextData/derivedSymbolData (default true)
 * @returns {{
 *   nodeChanges: Object[],
 *   guidMap: Map<string,{sessionID:number, localID:number}>,
 *   stats: { count:number, types:Object, blobRefsKept:number, blobRefsDropped:number }
 * }}
 */
export function cloneSubtree({
  scenegraphPath,
  sourceGuid,
  newSessionID,
  localIDStart = 1,
  nameSuffix = ' (clone)',
  stripDerived = true,
}) {
  const r = JSON.parse(readFileSync(scenegraphPath, 'utf8'));

  // Build a flat map guid → {node, sourceFrameIdx} and parent → children index
  // over every nodeChange we have on hand. We track which frame each node came
  // from because that frame's blobs[] is the lookup table for that node's
  // numeric *Blob references — copying blobs across frames requires knowing
  // which set of bytes the index points to.
  const nodesByGuid = new Map();        // guid → { node, frameIdx }
  const childrenByParent = new Map();
  const blobsByFrameIdx = new Map();    // frameIdx → blobs array
  for (let fi = 0; fi < r.length; fi++) {
    const f = r[fi];
    if (f.decoded?.blobs?.length) blobsByFrameIdx.set(fi, f.decoded.blobs);
    for (const c of (f.decoded?.nodeChanges || [])) {
      const id = gidStr(c.guid);
      if (!id) continue;
      if (!nodesByGuid.has(id)) nodesByGuid.set(id, { node: c, frameIdx: fi });
      const pid = gidStr(c.parentIndex?.guid);
      if (pid) {
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(id);
      }
    }
  }
  if (!nodesByGuid.has(sourceGuid)) {
    throw new Error(`cloneSubtree: source node ${sourceGuid} not found in ${scenegraphPath}`);
  }

  // BFS the subtree from the root so the resulting list is in parent-first order.
  // The Figma server is tolerant of any order inside a single message because all
  // nodeChanges arrive atomically, but parent-first is friendlier for debugging.
  const order = [];
  const queue = [sourceGuid];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const child of (childrenByParent.get(id) || [])) queue.push(child);
  }

  // Allocate fresh local IDs for every node in the subtree
  let nextLocal = localIDStart;
  const guidMap = new Map(); // oldId → newGuid {sessionID, localID}
  for (const id of order) {
    guidMap.set(id, { sessionID: newSessionID, localID: nextLocal++ });
  }

  // Build the cloned nodeChanges. We collect blob references in a first pass
  // so we know which source bytes to copy and how to remap the indices.
  const nodeChanges = [];
  let blobRefsDropped = 0;
  // Map "<sourceFrameIdx>:<oldBlobIdx>" → newBlobIdx (0-based in our outgoing message)
  const blobIndexMap = new Map();
  // The actual bytes we'll send, in newIdx order
  const outgoingBlobs = [];

  function countBlobRefs(v) {
    if (!v || typeof v !== 'object') return 0;
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number' && /Blob$/.test(k)) n++;
      else if (val && typeof val === 'object') n += countBlobRefs(val);
    }
    return n;
  }
  // Walk the cloned object recursively and remap any *Blob field. The remap
  // looks up the original blob from the source frame, copies it into our
  // outgoing array on first sight, and rewrites the field to the new index.
  function remapBlobRefs(v, sourceFrameIdx) {
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number' && /Blob$/.test(k)) {
        const key = `${sourceFrameIdx}:${val}`;
        let newIdx = blobIndexMap.get(key);
        if (newIdx === undefined) {
          const sourceBlobs = blobsByFrameIdx.get(sourceFrameIdx);
          if (!sourceBlobs || val >= sourceBlobs.length) {
            // Couldn't find the source blob — drop the ref by zeroing it.
            // The shape will render empty rather than crashing the message.
            v[k] = 0;
            continue;
          }
          newIdx = outgoingBlobs.length;
          outgoingBlobs.push(revive(sourceBlobs[val]));
          blobIndexMap.set(key, newIdx);
        }
        v[k] = newIdx;
      } else if (val && typeof val === 'object') {
        remapBlobRefs(val, sourceFrameIdx);
      }
    }
  }

  for (const oldId of order) {
    const { node: src, frameIdx } = nodesByGuid.get(oldId);
    const newGuid = guidMap.get(oldId);
    // Build the cloned change: revive wrapped values, strip derived* if asked,
    // remap guid + parent
    const clone = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === 'guid' || k === 'parentIndex') continue;        // handled below
      if (stripDerived && STRIP_FIELDS.has(k)) {
        blobRefsDropped += countBlobRefs(v);
        continue;
      }
      if (k === 'editScopeInfo' || k === 'editInfo') continue;  // optional metadata, drop
      clone[k] = revive(v);
    }
    clone.guid = newGuid;
    clone.phase = 'CREATED';

    // Walk the cloned fields and rewrite every *Blob index using this node's
    // source frame as the lookup table. Side effect: copies the referenced
    // blob bytes into outgoingBlobs.
    remapBlobRefs(clone, frameIdx);

    // parentIndex: root keeps the original parent (so the clone appears next to
    // the source); descendants point at the cloned parent.
    if (oldId === sourceGuid) {
      // Reuse the source's parentIndex verbatim, just revived
      if (src.parentIndex) clone.parentIndex = revive(src.parentIndex);
    } else {
      const parentOldId = gidStr(src.parentIndex?.guid);
      const newParentGuid = guidMap.get(parentOldId);
      if (!newParentGuid) {
        throw new Error(`cloneSubtree: descendant ${oldId} has unmapped parent ${parentOldId}`);
      }
      clone.parentIndex = {
        guid: newParentGuid,
        // Reuse the source position string verbatim — Figma's fractional
        // ranking permits siblings to share a position.
        position: src.parentIndex?.position,
      };
    }

    // Tag the root with a name suffix so it's easy to find in the layers panel
    if (oldId === sourceGuid && clone.name) {
      clone.name = clone.name + nameSuffix;
    }

    nodeChanges.push(clone);
  }
  const blobRefsKept = outgoingBlobs.length;

  // Stats by type
  const types = {};
  for (const c of nodeChanges) {
    const t = c.type || '?';
    types[t] = (types[t] || 0) + 1;
  }

  return {
    nodeChanges,
    blobs: outgoingBlobs,
    guidMap,
    stats: { count: nodeChanges.length, types, blobRefsKept, blobRefsDropped, blobsCopied: outgoingBlobs.length },
  };
}

/**
 * Helper to wrap a {x, y} into the OptionalVector shape Figma's wire format
 * uses for minSize / maxSize. Pass either {x:N, y:N} or null to clear.
 */
export function optionalVector(v) {
  if (v == null) return undefined;
  if ('value' in v) return v;
  return { value: v };
}
