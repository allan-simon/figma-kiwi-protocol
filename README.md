# figma-kiwi-protocol

Decode Figma's binary Kiwi wire protocol. Extract the full scenegraph, SVG vectors, and CSS properties from WebSocket frames — no REST API rate limits, no paid plan required.

## What this does

Figma uses [Kiwi](https://github.com/nicowilliams/kiwi) (a binary serialization format by Evan Wallace) over WebSocket for real-time sync between the editor and the server. When you open a Figma file in the browser, the entire scenegraph — every node, every vector path, every style — is streamed as Kiwi-encoded binary frames.

This library intercepts those frames via Chrome DevTools Protocol, decodes the binary data, and gives you structured access to everything Figma knows about your design:

- **Full scenegraph** as JSON (5000+ nodes for a typical file)
- **SVG path extraction** from Figma's proprietary `commandsBlob` and `vectorNetworkBlob` binary formats
- **CSS properties** from both the decoded scenegraph and the REST API
- **Component variants**, prototype interactions, and state machines
- **Image hash mapping** to Figma's CDN URLs

## Why

The Figma REST API has aggressive rate limits. The official MCP server requires a paid Dev Mode subscription. Community MCP servers hit the same REST API limits.

This tool reads the same data Figma's own editor reads — directly from the WebSocket stream. No rate limits. No paid plan. Just the raw protocol.

## Architecture

```
lib/          Pure functions — buffer in, data out. No I/O, no side effects.
├── kiwi.mjs         fig-wire frame detection and schema extraction
├── scenegraph.mjs   decode, merge, and query scenegraph data
├── svg.mjs          commandsBlob / vectorNetworkBlob → SVG paths
├── css.mjs          node properties → CSS (Kiwi + REST API formats)
└── index.mjs        re-exports everything

bin/          CLI tools — CDP capture, file I/O, orchestration.
├── cli.mjs              entry point
├── capture.mjs          single page WebSocket capture
├── capture-all-pages.mjs   multi-page capture (auto-discovers pages)
├── decode.mjs           binary → JSON scenegraph
└── extract-svgs.mjs     vector nodes → individual SVG files
```

The lib has **zero dependencies** and **zero I/O**. It takes `Uint8Array` buffers and returns objects. You can use it in an MCP server, a Figma plugin, a build tool, or anything else.

The CLI tools handle the messy parts: Chrome DevTools Protocol, file system, zstd decompression, Kiwi decoder generation.

## Quick start

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

## Library usage

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
  // decompress with fzstd, then generate decoder with kiwi CLI
}
```

## Binary formats documented

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

## License

MIT
