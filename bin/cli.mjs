#!/usr/bin/env node
// figma-kiwi-protocol CLI entry point

const cmd = process.argv[2];

const commands = {
  capture: './capture.mjs',
  'capture-all-pages': './capture-all-pages.mjs',
  decode: './decode.mjs',
  'extract-svgs': './extract-svgs.mjs',
  'to-html': './to-html.mjs',
};

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`figma-kiwi-protocol — decode Figma's binary Kiwi protocol

Usage:
  figma-kiwi-protocol <command>

Commands:
  capture             Capture WebSocket frames from a single page reload
  capture-all-pages   Capture all pages (discovers via REST API)
  decode              Decode captured frames into scenegraph.json
  extract-svgs        Extract VECTOR nodes as individual SVG files
  extract-svgs --compose <id>  Compose SYMBOL icon into inline-ready SVG
  to-html             Generate HTML/Tailwind from scenegraph nodes

Environment variables:
  CDP_WS_URL        Chrome DevTools WebSocket URL
  FIGMA_TOKEN       Figma personal access token
  FIGMA_FILE_KEY    Figma file key (from URL)
  FIGMA_KIWI_DIR    Output directory (default: /tmp/figma_kiwi)

Workflow:
  1. Open your Figma file in Chrome (with --remote-debugging-port=9222)
  2. figma-kiwi-protocol capture-all-pages    # capture binary frames
  3. figma-kiwi-protocol decode               # decode into JSON scenegraph
  4. figma-kiwi-protocol extract-svgs         # extract vector SVGs
  5. figma-kiwi-protocol to-html <node_id>    # generate HTML from a node
  6. figma-kiwi-protocol extract-svgs --compose <id>  # compose icon SVG

Library usage:
  import { commandsBlobToPath, extractSvgs, buildTree } from 'figma-kiwi-protocol';
`);
  process.exit(0);
}

if (!(cmd in commands)) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Run figma-kiwi-protocol --help for usage`);
  process.exit(1);
}

// Forward remaining args and import the command
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
await import(commands[cmd]);
