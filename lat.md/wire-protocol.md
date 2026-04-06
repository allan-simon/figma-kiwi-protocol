# Wire protocol

Figma's binary multiplayer protocol over a single WebSocket. Each frame is a zstd-compressed Kiwi-encoded `Message`. Both directions use the same envelope and schema, so the codec is symmetric.

## Transport

Single binary WebSocket per file. URL is `wss://www.figma.com/api/multiplayer/<fileKey>?...` with several query parameters that the server parses strictly.

### URL parameters

The Figma server is picky about query string format. Re-encoding the URL via `URL.searchParams` breaks the connection silently — the server returns a `JOIN_START` and stops sending. See [[standalone-client#Standalone client#standalone-client.mjs#URL serialization gotcha]] for the workaround.

- `role=editor` — required for write access
- `tracking_session_id=<random>` — 16-char base64url, rotate on each connection
- `version=151` — protocol version, copy from observed Chrome handshake
- `recentReload=0` — set to `0` for fresh connection
- `file-load-streaming-compression` — bare flag (NO `=` sign), enables streaming sync
- `scenegraph-queries-initial-nodes=0:1` — colon must NOT be percent-encoded
- `user-id=<numeric>` — from cookies / Figma user
- `client_release=<commit-hash>` — copy from observed Chrome handshake

### Auth

Just cookies. Send all `figma.com` cookies (~19 of them, ~2.5KB total) in the `Cookie` request header along with `Origin: https://www.figma.com`. No bearer tokens, no Authorization header, no `X-Figma-Token`.

### Compression

Every binary frame is zstd-compressed Kiwi. Even tiny 26-byte heartbeats are compressed.

Use `node:zlib.zstdCompressSync` / `zstdDecompressSync` (Node ≥ 22.15). The Node-built recompressed version is bytewise different from Figma's (different level/dict) but decodes identically and the server accepts it.

## Message envelope

Top-level `Message` shape — same for both directions. Distinguished by `type`. Field order doesn't matter (Kiwi is tag-based) so re-encoded messages don't have to byte-match the original.

```js
{
  type: 'NODE_CHANGES' | 'USER_CHANGES' | 'CLIENT_BROADCAST' | 'CLIENT_RENDERED'
      | 'JOIN_START' | 'JOIN_END' | 'SCENE_GRAPH_REPLY' | 'SIGNAL' | ...,
  sessionID: <int>,         // server-assigned, present on NODE_CHANGES only
  ackID: <int>,              // monotonic counter, present on NODE_CHANGES only
  sentTimestamp: BigInt,     // millis since epoch
  nodeChanges: [...],        // for NODE_CHANGES
  userChanges: [...],        // for USER_CHANGES (cursor, selection, viewport, heartbeat)
  broadcasts: [...],         // for CLIENT_BROADCAST
  blobs: [...],              // binary blobs (geometry caches etc)
  clientRenderedMetadata: {...},  // for CLIENT_RENDERED — loadID, trackingSessionId
}
```

### Message types observed

The set is far from complete. Only the ones encountered during write RE are documented; many more exist in the schema.

- `JOIN_START` — server's first message after schema, assigns `sessionID`
- `NODE_CHANGES` — the only mutation type, both directions
- `USER_CHANGES` — cursor, selection, viewport, heartbeat
- `CLIENT_BROADCAST` — presence broadcasts, comments
- `CLIENT_RENDERED` — client tells server it has finished loading
- `SCENE_GRAPH_REPLY` — server response to a scenegraph query
- `JOIN_END` — server marks initial sync complete
- `SIGNAL` — generic server-pushed signals

## sessionID + ackID

The client-owned counter `ackID` is the most subtle part of the protocol. It is the basis on which the server pairs messages and acknowledgements.

### sessionID

Assigned by the server in `JOIN_START`. Stays constant for the lifetime of the WebSocket connection. Same ID is also used as the namespace prefix for any new node `guid` the client creates. Each new file open gets a fresh sessionID.

### ackID

A monotonically-increasing integer the **client** owns. The server echoes it back verbatim in the response `NODE_CHANGES` frame.

Observed: real Chrome client increments by ~21 per message — likely accounting for ~20 internal sub-ops per high-level user action. Standalone clients can use lower increments; ackID=25 was accepted at the start of a fresh session.

### Server ack pattern

When the client sends `{NODE_CHANGES, sessionID:S, ackID:A, nodeChanges:[...]}`, the server replies within ms with the same envelope.

The reply echoes the same change set (minus `editScopeInfo`, plus a derived `aiEditScopeLabel`). Same `ackID` = confirmation that this specific message was applied.

## nodeChanges

The mutation primitive. Each entry is a partial node spec keyed by `guid`. Only fields present are updated; missing fields are unchanged. This is the foundation of Figma's collaborative editing — every edit is a sparse patch.

```js
{
  guid: { sessionID: <int>, localID: <int> },  // node identity
  // ...any subset of NodeChange fields...
  name: 'New Layer Name',
  stackMode: 'HORIZONTAL',
  // ...
}
```

### `phase` field

Discriminates between full-state nodes and incremental updates.

Server-side full sync has every node with `phase: 'CREATED'`. Client mutations to existing nodes do NOT include `phase`. New-node creation does (phase=CREATED with the full set of fields).

### `editScopeInfo` is OPTIONAL for writes

Real Chrome attaches an `editScopeInfo` to every user-initiated mutation, containing the action stack (e.g. `stack-selected-nodes`).

This is metadata for the collab UI and edit history. **The server accepts mutations without it.** Validated empirically — see [[standalone-client#Standalone client#standalone-client.mjs#First confirmed write]].

### Companion `{guid:0:1}` change is OPTIONAL

Real Chrome pairs every NODE_CHANGES with a second nodeChange targeting the document root (`guid 0:1`).

It carries just `editInfo` and `editScopeInfo`. **Also not required.** A single-element `nodeChanges` array works.

## Auto-layout vocabulary

Figma's wire format calls auto-layout `stack`, not `layout`. This is the most surprising vocabulary mismatch with Figma's plugin API. See [[auto-layout]] for the full mapping.

## See also

Pointers to the related sections of this knowledge base.

- [[capture]] — capturing wire frames via CDP
- [[standalone-client]] — opening our own WebSocket
- [[auto-layout]] — stack* fields and their plugin-API equivalents
