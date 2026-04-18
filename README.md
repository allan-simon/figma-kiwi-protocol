# figma-kiwi-protocol

Read **and write** Figma files over their binary Kiwi wire protocol. Extract the full scenegraph, SVG vectors, and CSS from WebSocket frames — then push mutations back to live files from a script, no UI automation. No REST API rate limits, no paid plan required.

Ships as a **[lib](#library-usage)**, **[CLI](#quick-start)**, **[MCP server](#mcp-server)**, and **[Claude Code plugin](#claude-code-plugin)**.

## What this does

Figma uses [Kiwi](https://github.com/nicowilliams/kiwi) (a binary serialization format by Evan Wallace) over WebSocket for real-time sync between the editor and the server. When you open a Figma file in the browser, the entire scenegraph — every node, every vector path, every style — is streamed as Kiwi-encoded binary frames.

This library speaks that protocol in both directions.

**Read** — intercept frames via Chrome DevTools Protocol, decode the binary, and get structured access to everything Figma knows about your design:

- **Full scenegraph** as JSON (5000+ nodes for a typical file)
- **SVG path extraction** from Figma's proprietary `commandsBlob` and `vectorNetworkBlob` binary formats
- **CSS properties** from both the decoded scenegraph and the REST API
- **Component variants**, prototype interactions, and state machines
- **Image hash mapping** to Figma's CDN URLs

**Write** — open a standalone Node WebSocket to Figma's multiplayer endpoint (no Chrome at runtime) and apply mutations that propagate live to every connected editor:

- **Rename layers**, toggle auto-layout, change padding, spacing, hug/fixed sizing
- **Deep-clone** a subtree into a fresh independent copy (60+ nodes in one shot)
- **Author from scratch** with a builder that pre-handles the wire-format gotchas
- **Batch edits** from a JSON file, with dry-run support

## Why

The Figma REST API has aggressive rate limits and is read-only. The official MCP server requires a paid Dev Mode subscription. Community MCP servers hit the same REST API limits. Plugins run in the browser sandbox and can't be driven from a script or CI.

This tool reads and writes the same data Figma's own editor reads and writes — directly off the WebSocket. No rate limits. No paid plan. No browser at runtime once cookies are captured. Just the raw protocol.

## Architecture

```
lib/          Pure functions — buffer in, data out. No I/O, no side effects.
├── kiwi.mjs         fig-wire frame detection and schema extraction
├── scenegraph.mjs   decode, merge, and query scenegraph data
├── svg.mjs          commandsBlob / vectorNetworkBlob → SVG paths
├── css.mjs          node properties → CSS (Kiwi + REST API formats)
├── session.mjs      FigmaSession — persistent multiplayer WebSocket + mutate()
├── clone.mjs        cloneSubtree — deep copy a node subtree into fresh guids
├── builder.mjs      FigmaBuilder — author nodes from scratch with gotchas handled
└── index.mjs        re-exports everything

bin/          CLI tools — CDP capture, file I/O, orchestration.
├── cli.mjs                   entry point
├── capture.mjs               single page WebSocket capture
├── capture-all-pages.mjs     multi-page capture (auto-discovers pages)
├── decode.mjs                binary → JSON scenegraph
├── decode-frames.mjs         decode every captured frame for inspection
├── extract-svgs.mjs          vector nodes → individual SVG files
├── to-html.mjs               scenegraph node → HTML / Tailwind
├── recon-handshake.mjs       one-shot CDP: steal cookies + multiplayer URL
├── standalone-client.mjs     low-level probe: full handshake + one mutation
├── figma-write.mjs           high-level write CLI (rename, auto-layout, …)
├── figma-clone.mjs           deep-clone a subtree into a new independent copy
└── build-footer-fresh.mjs    example: author a component from scratch
```

The read path is CDP-attached — the user's Chrome bears the auth, we just listen. The write path is **standalone**: `recon-handshake` steals cookies and the multiplayer URL once, then `FigmaSession` opens its own WebSocket from Node. No Chrome at runtime, no UI automation, runs from CI.

The lib has **zero runtime dependencies** on the read path and returns plain objects. `FigmaSession` uses `ws` and Node 22's built-in `node:zlib` zstd — no native modules. Kiwi encoding/decoding uses the schema Figma itself sends us in the first WebSocket frame.

## Quick start — read

```bash
npm install figma-kiwi-protocol

# 1. Open your Figma file in Chrome with remote debugging:
#    chrome --remote-debugging-port=9222

# 2. Set environment variables:
export CDP_WS_URL="ws://localhost:9222/devtools/browser/<id>"
export FIGMA_TOKEN="figd_..."        # for page discovery
export FIGMA_FILE_KEY="abc123def"    # from your Figma URL

# 3. Capture all pages:
npx figma-kiwi-protocol capture-all-pages

# 4. Decode into JSON:
npx figma-kiwi-protocol decode

# 5. Extract SVGs:
npx figma-kiwi-protocol extract-svgs
```

## Quick start — write

```bash
# 1. One-shot recon: steal cookies + multiplayer URL from your open Chrome tab.
#    Writes /tmp/figma_handshake.json — rerun only when cookies expire.
npx figma-kiwi-protocol recon-handshake

# 2. Rename a layer by guid (format: sessionID:localID from the decoded scenegraph)
npx figma-kiwi-protocol write rename 2004:16177 "HELLO_FROM_NODE"

# 3. Turn a frame into a horizontal auto-layout stack that hugs its contents
npx figma-kiwi-protocol write enable-al 2010:16169 \
    --direction HORIZONTAL --hug both --padding 16 --spacing 8

# 4. Deep-clone a component (60+ nodes, new guids, independent subtree)
npx figma-kiwi-protocol clone 41:1923 --name-suffix " (clone)"

# 5. Batch mode — run many mutations from a JSON file, dry-run first
npx figma-kiwi-protocol write batch ./changes.json --dry-run
```

All mutations propagate live to every other connected Figma client — collaborators see the edit appear in real time, same as if you'd typed it.

## Library usage

### Read

```javascript
import {
  commandsBlobToPath,
  vectorNetworkBlobToPath,
  extractSvgs,
  extractCSSFromKiwi,
  isFigWireFrame,
  extractCompressedSchema,
  mergePages,
  buildTree,
} from 'figma-kiwi-protocol';

// Decode a commandsBlob to SVG path
const svgPath = commandsBlobToPath(blobBytes);
// → "M 0.00 0.00 L 24.00 0.00 L 24.00 24.00 Z"

// Extract CSS from a decoded node
const css = extractCSSFromKiwi(nodeChange);
// → { width: "100px", display: "flex", background: "#1a1a1a", ... }

// Check if a binary frame contains the Kiwi schema
if (isFigWireFrame(frameBytes)) {
  const compressedSchema = extractCompressedSchema(frameBytes);
  // decompress with zstd, then generate decoder with kiwi CLI
}
```

### Write

```javascript
import { FigmaSession } from 'figma-kiwi-protocol/session';
import { cloneSubtree } from 'figma-kiwi-protocol/clone';
import { FigmaBuilder } from 'figma-kiwi-protocol/builder';

// Open a persistent multiplayer session from /tmp/figma_handshake.json
const session = await FigmaSession.connect();

// High-level helpers — each resolves when the server echoes back our ackID
await session.rename({ sessionID: 2004, localID: 16177 }, 'New Name');
await session.setStackMode({ sessionID: 2010, localID: 16169 }, 'HORIZONTAL');
await session.setPadding({ sessionID: 2010, localID: 16169 }, { all: 16 });

// Deep-clone a 60-node component into a fresh independent subtree
const { nodeChanges, blobs } = cloneSubtree({
  scenegraph,          // decoded scenegraph from capture + decode-frames
  sourceGuid: '41:1923',
  sessionID: session.sessionID,
  nameSuffix: ' (clone)',
});
await session.mutate({ nodeChanges, blobs });

// Author a new frame from scratch — builder pre-handles OptionalVector wrapping
// and sibling parentIndex.position uniqueness (see lat.md/builder.md)
const b = new FigmaBuilder({ sessionID: session.sessionID });
const root = b.frame({ name: 'Card', stackMode: 'VERTICAL', padding: 16 });
b.rectangle({ parent: root, size: { x: 320, y: 120 } });
await session.mutate({ nodeChanges: b.build() });

await session.close();
```

## Binary formats documented

Machine-readable [Kaitai Struct](https://kaitai.io/) specifications (`.ksy`) are in [`kaitai/`](kaitai/) — you can generate parsers in any language or visualize binary data in the [Kaitai Web IDE](https://ide.kaitai.io/).

### fig-wire frame
```
Offset  Size  Description
0       8     Magic: "fig-wire" (ASCII)
8       4     Version (uint32 LE)
12      ...   zstd-compressed Kiwi schema (~558 types)
```

### commandsBlob (pre-computed SVG paths)
```
Byte  Command      Parameters
0x01  MoveTo       x(f32) y(f32)
0x02  LineTo       x(f32) y(f32)
0x03  ClosePath    (none)
0x04  CubicBezier  x1(f32) y1(f32) x2(f32) y2(f32) x(f32) y(f32)
0x00  (separator)  subpath boundary
```

### vectorNetworkBlob (editable path data)
```
Header: vertexCount(u32) segmentCount(u32) regionCount(u32)

Per vertex (12 bytes):
  flags(u32) x(f32) y(f32)

Per segment (28 bytes):
  flags(u32) startVertexIdx(u32) tangentStartX(f32) tangentStartY(f32)
  endVertexIdx(u32) tangentEndX(f32) tangentEndY(f32)
```

## Legal

This tool exercises the right to reverse-engineer for interoperability, as provided by:

- **EU Directive 2009/24/EC, Article 6** — permits decompilation and reverse-engineering of software for interoperability purposes, without authorization from the rightholder
- **French Code de la propriété intellectuelle, Article L122-6-1 IV** — French transposition of the above

Contractual clauses (such as Terms of Service) that restrict this statutory right are void under EU law.

This project contains no Figma proprietary code. It only decodes the wire format of data transmitted to the user's own browser.

*Not affiliated with Figma, Inc.*

## MCP server

Expose Figma scenegraph tools to any MCP-compatible AI tool (Claude Code, Cursor, Windsurf, VS Code).

### Configure

Add to `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": ["/path/to/figma-kiwi-protocol/mcp/server.mjs"],
      "env": {
        "FIGMA_KIWI_DIR": "/tmp/figma_kiwi"
      }
    }
  }
}
```

### Tools exposed

| Tool | Description |
|------|-------------|
| `figma_pages` | List all pages |
| `figma_page` | Show page tree at configurable depth |
| `figma_node` | Inspect node with CSS and tree |
| `figma_search` | Search nodes by name |
| `figma_css` | Extract CSS properties |
| `figma_texts` | Extract all text from a page |
| `figma_components` | List components and variants |

Requires a decoded scenegraph — run `figma-kiwi-protocol capture-all-pages` then `decode` first.

## Claude Code plugin

This repo ships as an installable Claude Code plugin with a skill that lets Claude explore Figma designs directly.

### Install

```bash
# Test locally
claude --plugin-dir /path/to/figma-kiwi-protocol

# Or install from GitHub
/plugin marketplace add allan-simon/figma-kiwi-protocol
/plugin install figma-kiwi-protocol
```

### Use

The skill is auto-invoked by Claude when you ask about Figma designs. Just give Claude a Figma URL or ask it to explore a design — it will use the skill automatically.

Claude will have access to all capture, decode, and query commands.

## Known limitations / TODO

### SVG extraction
- **Composite icons**: Icon SYMBOLs with child VECTOR nodes need transform composition (parent + children → one SVG). Currently each VECTOR is extracted individually.
- **Transforms**: Rotation/translation matrices on child nodes are not applied to SVG output yet.
- **Boolean operations**: BOOLEAN_OPERATION nodes (union, subtract, intersect) are not handled — these combine child paths.
- **Computed shapes**: ROUNDED_RECTANGLE, ELLIPSE, STAR, REGULAR_POLYGON don't have `commandsBlob` — their geometry is computed from parameters. Need to generate SVG paths from cornerRadius, point count, etc.
- **Image fills**: `type: IMAGE` references SHA1 hashes, not vector data. Use the image batch endpoint to resolve URLs.

### Scenegraph
- **Prototype interactions**: Decoded but not yet exposed in the MCP server or lib API.
- **Component property overrides**: Parsed (symbolOverrides, componentPropAssignments) but not exposed in query tools.
- **Gradient fills**: Decoded from Kiwi but CSS extraction only outputs solid colors.

### Protocol
- **Incremental updates**: Only the initial full scenegraph load is captured. Real-time edits (subsequent smaller WS frames) are not decoded.
- **Schema versioning**: The Kiwi schema (~558 types) is extracted per-session. Figma may change it at any time.

### Write
- **INSTANCE overrides**: Mutating `stack*` or `name` on an INSTANCE acks at the protocol level but the server silently reverts it — instance overrides go through a mechanism we haven't reversed yet. Workaround: [deep-clone](#library-usage) the main component, edit the clone, then port.
- **TEXT from scratch**: The builder does not yet author TEXT nodes (they require fontName, fontSize, lineHeight, letterSpacing, fontVariations, textData…). Clone an existing TEXT leaf and override `characters` instead.
- **SYMBOL from scratch**: The builder produces FRAMES, not main components. Convert to a component in the UI after authoring.
- **Gradient / image fills in builder**: Only solid colors are wired up; image fills work when cloning because `__bytes` hashes are inherited inline.

### Distribution
- **npm publish**: Not yet published to npm registry.
- **Kaitai Web IDE**: Sample fixture files exist but aren't hosted for direct web visualization.

## License

MIT
