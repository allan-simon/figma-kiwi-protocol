# Deep clone

Server-side deep duplication of a node subtree via the multiplayer wire protocol.

Built on the discovery that Figma's own Cmd+D on a main Component does NOT actually deep-copy — it creates an INSTANCE — so reproducing real "duplicate this component" behaviour requires emitting a fresh subtree of nodes ourselves.

## Why this exists

Figma's UI Cmd+D on a SYMBOL creates an INSTANCE that references the original main.

Mutating the instance's `stack*` or `name` fields directly via the wire protocol succeeds at ack time but is silently reverted by the server, because instance overrides go through a different mechanism we have not reversed yet. For the workflow of safely fixing components in a library — duplicate first, edit the duplicate, port — we need a real independent deep copy. This module provides one.

## Validated end-to-end

Cloning the 60-node `Artist Description/Footer` component (guid `41:1923`) into a new SYMBOL with new guid `2042:1`.

All children — text, FRAMES, ROUNDED_RECTANGLE, LINE, and VECTOR icons — render correctly in the live file with no manual recovery needed.

## lib/clone.mjs

A single function `cloneSubtree` that takes a cached scenegraph + a source guid + a target sessionID and returns a list of `nodeChanges` plus a `blobs` array, both ready to feed into `FigmaSession.mutate()`.

### Strategy: strip derived, copy raw

Two large field groups are computed by Figma's server from raw fields: `derivedTextData` (text glyph paths) and `derivedSymbolData`.

These account for ~93% of all blob references on a typical text-heavy subtree. We strip them before cloning so most blobs never need to be copied at all.

Stripping them at clone time eliminates 314 of 335 blob refs in the Footer subtree, leaving only ~20 to copy. Empirically the server recomputes the derived fields from `textData`, `fontName`, `fillPaints`, and so on — the cloned text renders correctly without any of the derived data being sent.

### Blob index remapping

Each NODE_CHANGES message has its own `blobs[]` array. Numeric `*Blob` fields (`commandsBlob`, `vectorNetworkBlob`) are indices into that local array. Cloning a node means copying every blob it references and rewriting the indices.

The implementation walks each cloned node recursively, finds every numeric `*Blob` field, and on first sight of `<sourceFrameIdx>:<oldIdx>` copies the source frame's blob into the outgoing `blobs[]` array at a new local index. Subsequent references to the same source blob reuse that new index.

### parentIndex remapping

The root keeps its original `parentIndex` verbatim, so the duplicate appears as a sibling of the source.

Every descendant has its `parentIndex.guid` rewritten to point at the cloned parent via an `oldGuid → newGuid` lookup table built up-front.

### Position keys

Figma stores child order as fractional ranking strings on `parentIndex.position`.

Two siblings with the same position are tolerated, so the clone reuses the source's position string verbatim. A future version could rebalance these to insert the clone immediately after the source.

## bin/figma-clone.mjs

CLI wrapper around `cloneSubtree` plus `FigmaSession`. Single command:

```
node bin/cli.mjs clone <sourceGuid>
  [--scenegraph /tmp/figma_full_sync/frames_decoded.json]
  [--name-suffix " (clone)"]
  [--keep-derived]
  [--dry-run]
```

The cached scenegraph is produced by `node bin/cli.mjs capture` (with reload) followed by `node bin/cli.mjs decode-frames` — see [[capture#Schema extraction]].

## Known limitations

What the current cut does not handle. Each is a known cut-corner with a clear path forward if needed.

- Position keys are reused verbatim from the source, so the clone shares its sibling order rank with the original
- Cloning a SYMBOL creates a new SYMBOL — to clone "as a regular Frame" you would need to switch the type and drop SYMBOL-specific fields
- Image fills work because the `__bytes` hashes are inline on `fillPaints` and inherited automatically; uploaded raster data is server-side, not in the wire blobs
- INSTANCE children inside the cloned subtree keep their original `componentRef` — they remain linked to the same upstream main component
