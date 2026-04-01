---
name: figma-kiwi-protocol
description: Explore Figma designs by decoding the binary Kiwi wire protocol — full scenegraph access, SVG extraction, CSS properties, no REST API rate limits.
user-invocable: true
---

# Figma Kiwi Protocol — Design Explorer

Decode and explore Figma designs via the binary Kiwi wire protocol. Bypasses REST API rate limits by reading the same data Figma's editor reads — directly from the WebSocket stream.

## Setup

### Prerequisites

- Node.js >= 18
- Chrome with remote debugging enabled
- A Figma account (free plan works)

### Environment variables

Set these before using any command:

```bash
export CDP_WS_URL="ws://host:port/devtools/browser/<id>"   # Chrome DevTools WebSocket
export FIGMA_TOKEN="figd_..."                                # Figma personal access token
export FIGMA_FILE_KEY="abc123def"                            # From your Figma URL
export FIGMA_KIWI_DIR="/tmp/figma_kiwi"                      # Output directory (default)
```

To get `CDP_WS_URL`: start Chrome with `--remote-debugging-port=9222`, then fetch `http://localhost:9222/json/version` and use the `webSocketDebuggerUrl`.

To get `FIGMA_TOKEN`: Figma → Settings → Personal access tokens → Generate.

To get `FIGMA_FILE_KEY`: from your Figma URL `figma.com/design/<FILE_KEY>/...`.

### Install

The plugin directory is the repo itself. All scripts are in `bin/`.

```bash
PLUGIN_DIR="$(dirname "$(dirname "$(realpath "$0")")")"
```

## Workflow

### 1. Capture — grab WebSocket frames from Chrome

Open your Figma file in Chrome, then:

```bash
# Capture all pages (auto-discovers via REST API, ~14s per page)
node ${PLUGIN_DIR}/bin/capture-all-pages.mjs

# Or capture just the current page (faster)
node ${PLUGIN_DIR}/bin/capture.mjs 25
```

### 2. Decode — binary frames → JSON scenegraph

```bash
node ${PLUGIN_DIR}/bin/decode.mjs
```

Produces `$FIGMA_KIWI_DIR/scenegraph.json` (~27 MB for a typical file, 5000+ nodes).

First run auto-installs dependencies (fzstd, kiwi repo) and generates the Kiwi decoder (~558 types).

### 3. Query — explore the decoded scenegraph

Use the Python query tool for interactive exploration:

```bash
# List all pages
python3 ${PLUGIN_DIR}/query/local.py pages

# Show page tree
python3 ${PLUGIN_DIR}/query/local.py page <name> --depth 3

# Inspect a node (with CSS + state machine)
python3 ${PLUGIN_DIR}/query/local.py node <name_or_id>

# Search by name
python3 ${PLUGIN_DIR}/query/local.py search <pattern>

# Extract text content
python3 ${PLUGIN_DIR}/query/local.py texts <page_name>

# Get CSS properties
python3 ${PLUGIN_DIR}/query/local.py css <name_or_id>

# Prototype interactions
python3 ${PLUGIN_DIR}/query/local.py interactions <name_or_id>

# List components (with variant properties)
python3 ${PLUGIN_DIR}/query/local.py components [pattern]

# Component detail (variants, state machine, instances)
python3 ${PLUGIN_DIR}/query/local.py component <name_or_id>

# Find all instances of a component
python3 ${PLUGIN_DIR}/query/local.py instances <name_or_id>
```

### 4. Extract SVGs — vector nodes → individual SVG files

```bash
node ${PLUGIN_DIR}/bin/extract-svgs.mjs
```

Outputs individual `.svg` files to `$FIGMA_KIWI_DIR/svgs/` with an index at `svg_index.json`.

## Library usage (from JavaScript)

```javascript
import {
  commandsBlobToPath,
  vectorNetworkBlobToPath,
  extractSvgs,
  extractCSSFromKiwi,
  isFigWireFrame,
  mergePages,
  buildTree,
} from 'figma-kiwi-protocol';
```

## Exploration tips

1. **Start broad**: `pages` → `page <name> --depth 2` → understand layout
2. **Drill down**: `page <name> --depth 4` → see component hierarchy
3. **Search**: `search <pattern>` → find specific elements
4. **Inspect**: `node <id>` → full detail with CSS and state machine
5. **Components**: `component <name>` → variant properties, states, all instances

## Binary formats

Three binary formats are fully documented as Kaitai Struct specs in `kaitai/`:

- **`commands_blob.ksy`** — pre-computed SVG path commands (MoveTo, LineTo, CubicBezier, ClosePath)
- **`vector_network_blob.ksy`** — editable vector path data (vertices, segments with tangent handles, regions with loops)
- **`fig_wire_frame.ksy`** — WebSocket frame header containing the zstd-compressed Kiwi schema
