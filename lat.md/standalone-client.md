# Standalone client

A Node-side WebSocket client that talks directly to Figma's multiplayer endpoint, with no Chrome at runtime. Built once cookies are extracted via [[recon-handshake]]. The path that lets us write to live Figma files from scripts.

## Why standalone

Riding on top of the user's Chrome session via CDP `WebSocket.prototype.send` patching is fragile and unreliable.

Figma's bundle holds private references to `send`, the wrong execution context gets patched, and reloads break in-flight state. A direct connection avoids all of that. See [[wire-protocol]].

## recon-handshake.mjs

One-shot CDP recon that extracts everything needed to open a fresh connection later, then never touches Chrome again. Run it once per file (or whenever cookies expire).

### What it captures

Subscribes to `Network.webSocket*` events around a `Page.reload`.

Saves the multiplayer URL pattern, request/response headers, and all `figma.com` cookies to `/tmp/figma_handshake.json`.

### Output format

The JSON contains every WebSocket observed during reload (typically 2: the `livegraph` text WS and the `multiplayer` binary WS). `bin/standalone-client.mjs` picks the multiplayer one by URL match.

## standalone-client.mjs

Implements the full handshake + a single mutation, then closes. Designed as a probe; production usage will keep the socket open across multiple mutations.

### Connection sequence

The minimal viable handshake. Each step has been validated end-to-end with a server-confirmed write.

1. Read `/tmp/figma_handshake.json` for cookies + multiplayer URL pattern
2. Build a fresh URL: rotate `tracking_session_id`, keep everything else verbatim
3. Open `ws://` with `Cookie:` header containing all 19 figma.com cookies and `Origin: https://www.figma.com`
4. Receive fig-wire schema frame (~26KB) — skip, we already have the decoder
5. Receive `JOIN_START` (~60B) carrying our assigned `sessionID`
6. Receive full sync `NODE_CHANGES` (~2MB, 7990 nodes) carrying initial `ackID=0`
7. Send our mutation with `ackID = 0 + 25`
8. Receive server ack: `NODE_CHANGES` with same `ackID` echoing the mutation
9. Close with code 1000

### URL serialization gotcha

`URL.searchParams.set()` re-serializes the whole query string and breaks the connection silently.

It percent-encodes the colon in `scenegraph-queries-initial-nodes=0:1` and adds `=` to the bare `file-load-streaming-compression` flag. Use a regex on the raw URL string to rotate `tracking_session_id` instead.

### First confirmed write

Renamed a TEXT layer (`guid 2004:16177`) from `WRITE_TEST_RENAME_001` to `HELLO_FROM_STANDALONE`.

Server returned a `NODE_CHANGES` echoing our `ackID=25` and `fields=[guid,name]`. The other Chrome client saw the rename propagate live without reload — proof we are indistinguishable from a real Figma client.

## Future shape

The current `standalone-client.mjs` is a one-shot probe. The natural next iteration is a session class that holds the WebSocket open across multiple mutations, batches them, and exposes a clean high-level API.

### Persistent session

Hold the WebSocket across many mutations. Track the running `ackID` increment locally so the second mutation uses `ackID + 25` from our last value. Wait for each ack before counting the mutation as committed.

### High-level helpers

Wrap the protocol with one function per common operation: `renameLayer`, `setLayoutMode`, `setHugContents`, `setPadding`, etc.

These are pure JS objects that get folded into a `nodeChanges` entry by the session class. See [[auto-layout]] for the field mapping.

### Batch / dry-run mode

Read a list of intended changes from a YAML or JSON file, dry-run them (build the mutations and print) and optionally apply. Useful for the original use case: "fix all hardcoded-width frames in this file to use auto-layout hug-content".
