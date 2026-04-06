# Capture

CDP-attached read path. Connects to Chrome via the DevTools protocol and observes a Figma tab.

Used for capturing the schema, snapshotting a file's state, or recording a window of mutations. The original entry point, before [[standalone-client]] existed.

## bin/capture.mjs

Single-tab capture. Runs for N seconds, saves every binary WebSocket frame to `${FIGMA_KIWI_DIR}` as `frame_NNNN_{sent,recv}_SIZEb.bin`.

### Modes

Two ways to invoke, depending on whether you need a fresh sync or just to observe the user mid-action.

- Default: triggers `Page.reload` on connect, captures the initial sync flood
- `--no-reload`: attach to the existing session without disturbing it. Used to record user-initiated mutations during write-protocol RE.

### Filename format

Frames are written as `frame_NNNN_{sent,recv}_SIZEb.bin` with a zero-padded 4-digit index. Lexicographic sort matches capture order, which `bin/decode-frames.mjs` relies on for replaying mutation sequences.

## Schema extraction

The very first inbound frame after connect is the "fig-wire" frame, identified by a magic header. It contains the zstd-compressed Kiwi schema definition for this session.

### Pipeline

The full chain from raw bytes to a usable JS decoder. Cached per `FIGMA_KIWI_DIR` so repeated captures don't repeat the work.

1. Detect fig-wire frame via `isFigWireFrame()` (magic header check)
2. Extract the inner zstd payload via `extractCompressedSchema()`
3. Decompress with `node:zlib.zstdDecompressSync` (or fzstd as a portable fallback)
4. Generate a JS codec via Evan Wallace's Kiwi CLI: `npx tsx kiwi/js/cli.ts --schema schema.bin --js decoder.js`
5. The generated `figma_decoder.js` exports ~736 functions including `decodeMessage` AND `encodeMessage` — the encoder is free, no separate work needed

## bin/decode-frames.mjs

Decodes every captured frame (sent and recv) through `Schema.decodeMessage`. Built for write-protocol RE: scanning the asymmetry between sent and recv top-level keys reveals the mutation surface.

### Output

Writes `${FIGMA_KIWI_DIR}/frames_decoded.json` plus a per-direction histogram of top-level keys to stderr. The JSON serializer encodes BigInt as `{__bigint:"..."}` and `Uint8Array` as `{__bytes:"<base64>", len:N}` so the file is roundtrippable.

### Validation

Comparing top-level keys per direction confirms the schema is symmetric: SENT NODE_CHANGES messages have `{type, sentTimestamp, sessionID, ackID, nodeChanges}` and RECV adds only `reconnectSequenceNumber, blobBaseIndex` — server-only metadata.
