# figma-kiwi-protocol

Reverse-engineered Figma binary multiplayer protocol. Decode the scenegraph, extract SVG/CSS, and now also write mutations back to live files via a standalone WebSocket client that bypasses Chrome entirely.

## Goals

Two complementary use cases drive the project. Reading covers most workflows; writing was added once a path through the wire schema became clear.

### Read

Bypass Figma's rate-limited REST API by reading the same wire data the official client uses. Useful for design-to-code, asset extraction, and bulk inspection of large files where the REST API is too slow or quota-bounded.

### Write

Apply mutations to a Figma file from a script without driving the UI. Rename layers, toggle auto-layout, change properties.

The motivating use case is bulk-fixing components that hardcode sizes instead of using auto-layout, so a designer can see a concrete diff rather than a verbal request.

## Top-level layout

Each top-level directory has a single responsibility. The split between `lib/` (pure functions) and `bin/` (I/O entry points) is the most important convention to follow when adding code.

- `bin/` — CLI entry points: capture, decode, extract, write
- `lib/` — pure functions, no I/O: Kiwi schema extraction, scenegraph merge, SVG/CSS generation
- `kaitai/` — Kaitai Struct specs for binary sub-formats (commandsBlob, vectorNetworkBlob, fig-wire frame)
- `mcp/` — MCP server exposing read tools (figma_pages, figma_node, figma_search, figma_css, …)
- `query/` — Python CLI fallback for querying decoded scenegraph locally
- `skills/` — Claude Code plugin for design exploration from chat
- `test/` — fixture binaries and Kaitai validation

## Reverse-engineering pillars

The project rests on three discoveries that took most of the effort. Future work should not rediscover these.

### Kiwi schema is sent live, not built into the binary

Figma transmits the schema definition in the very first WebSocket frame — the "fig-wire" frame. Per-session, may evolve across releases.

We decode it via Evan Wallace's Kiwi CLI to generate a JS codec on the fly. See [[capture#Schema extraction]].

### The wire schema is symmetric

`Schema.decodeMessage()` works on both client→server and server→client frames. There is no separate "mutation message" type; mutations are just `NODE_CHANGES` messages with sparse partial updates. This is what made write support tractable. See [[wire-protocol#Message envelope]].

### The generated decoder includes encoders

`Schema.encodeMessage()` and ~700 sibling `encode*` functions exist in the same generated file. We never had to write a Kiwi encoder by hand. Combined with Node 22's built-in `node:zlib` zstd, the entire write path is dependency-free.

## Two transport modes

Reading and writing have evolved to use different transport mechanisms, for very different reasons. Both modes are supported.

### CDP-attached (read)

`bin/capture.mjs` connects to Chrome via CDP and observes the user's existing Figma tab. Used for: capturing the schema, snapshotting a file at a moment in time, debugging the protocol. The user's session bears the auth, we just listen. See [[capture]].

### Standalone client (write)

`bin/standalone-client.mjs` opens its OWN WebSocket to `wss://www.figma.com/api/multiplayer/<file>`. No Chrome at runtime.

Cookies are stolen one-shot via [[recon-handshake]]. Runs from CI, batch jobs, anywhere. Mutations propagate live to all other connected clients. See [[standalone-client]].
