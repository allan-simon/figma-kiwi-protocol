#!/usr/bin/env node
// figma-kiwi-protocol MCP server
// Exposes Figma scenegraph query tools over the Model Context Protocol.
//
// Usage:
//   node mcp/server.mjs
//
// Configure in Claude Code (.mcp.json):
//   {
//     "mcpServers": {
//       "figma-kiwi-protocol": {
//         "command": "node",
//         "args": ["/path/to/figma-kiwi-protocol/mcp/server.mjs"],
//         "env": {
//           "FIGMA_KIWI_DIR": "/tmp/figma_kiwi",
//           "FIGMA_TOKEN": "figd_...",
//           "FIGMA_FILE_KEY": "abc123"
//         }
//       }
//     }
//   }

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { extractCSSFromKiwi } from '../lib/css.mjs';
import { nodeId } from '../lib/scenegraph.mjs';

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const SG_PATH = `${DIR}/scenegraph.json`;

// --- Scenegraph loading (lazy, cached) ---

let _sg = null;
let _nodes = null;
let _parentMap = null;

function loadScenegraph() {
  if (_sg) return _sg;
  if (!existsSync(SG_PATH)) return null;
  _sg = JSON.parse(readFileSync(SG_PATH, 'utf8'));
  return _sg;
}

function getNodes() {
  if (_nodes) return _nodes;
  const sg = loadScenegraph();
  if (!sg) return null;

  _nodes = new Map();
  for (const nc of sg.nodeChanges || []) {
    const nid = nodeId(nc.guid);
    _nodes.set(nid, {
      id: nid,
      name: nc.name || '',
      type: nc.type || 'UNKNOWN',
      visible: nc.visible !== false,
      children: [],
      raw: nc,
    });
  }

  // Build parent-child
  for (const nc of sg.nodeChanges || []) {
    const nid = nodeId(nc.guid);
    const pi = nc.parentIndex;
    if (!pi?.guid) continue;
    const pid = nodeId(pi.guid);
    if (pid !== nid && _nodes.has(pid)) {
      _nodes.get(pid).children.push({ pos: pi.position || '', id: nid });
    }
  }
  for (const node of _nodes.values()) {
    node.children.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
    node.children = node.children.map(c => c.id);
  }

  return _nodes;
}

function getParentMap() {
  if (_parentMap) return _parentMap;
  const sg = loadScenegraph();
  if (!sg) return null;
  _parentMap = new Map();
  for (const nc of sg.nodeChanges || []) {
    const nid = nodeId(nc.guid);
    const pi = nc.parentIndex;
    if (!pi?.guid) continue;
    const pid = nodeId(pi.guid);
    if (pid !== nid) _parentMap.set(nid, pid);
  }
  return _parentMap;
}

function findByName(pattern) {
  const nodes = getNodes();
  if (!nodes) return [];
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const results = [];
  for (const [nid, n] of nodes) {
    if (re.test(n.name)) results.push(n);
    if (results.length >= 50) break;
  }
  return results;
}

function findById(id) {
  const nodes = getNodes();
  if (!nodes) return null;
  return nodes.get(id.replace('-', ':')) || null;
}

function findPageFor(nid) {
  const nodes = getNodes();
  const pm = getParentMap();
  if (!nodes || !pm) return null;
  const visited = new Set();
  let cur = nid;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const n = nodes.get(cur);
    if (n?.type === 'CANVAS') return { id: cur, name: n.name };
    cur = pm.get(cur);
  }
  return null;
}

function printTree(nid, depth = 3, indent = 0) {
  const nodes = getNodes();
  if (!nodes) return '';
  const n = nodes.get(nid);
  if (!n) return '';
  const prefix = '  '.repeat(indent);
  const vis = n.visible ? '' : ' [hidden]';
  const text = n.type === 'TEXT' && n.raw.textData?.characters
    ? ` → "${n.raw.textData.characters.slice(0, 80)}"` : '';
  let out = `${prefix}[${n.type}] ${n.name.slice(0, 60)} (${nid})${vis}${text}\n`;
  if (indent < depth) {
    for (const cid of n.children) {
      out += printTree(cid, depth, indent + 1);
    }
  }
  return out;
}

function requireScenegraph() {
  if (!existsSync(SG_PATH)) {
    return { content: [{ type: 'text', text: `No scenegraph found at ${SG_PATH}. Run the capture+decode pipeline first:\n  figma-kiwi-protocol capture-all-pages\n  figma-kiwi-protocol decode` }] };
  }
  return null;
}

// --- MCP Server ---

const server = new McpServer({
  name: 'figma-kiwi-protocol',
  version: '0.1.1',
});

// Tool: pages
server.tool(
  'figma_pages',
  'List all pages in the decoded Figma scenegraph',
  {},
  async () => {
    const err = requireScenegraph();
    if (err) return err;
    const nodes = getNodes();
    const pages = [...nodes.values()].filter(n => n.type === 'CANVAS');
    const lines = pages.map(p => `${p.id}  ${p.name}  (${p.children.length} children)`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Tool: page tree
server.tool(
  'figma_page',
  'Show a page tree structure at configurable depth',
  { name: z.string().describe('Page name or node ID'), depth: z.number().optional().default(3).describe('Tree depth (default 3)') },
  async ({ name, depth }) => {
    const err = requireScenegraph();
    if (err) return err;
    let target = findById(name);
    if (!target) {
      const matches = findByName(name).filter(n => n.type === 'CANVAS');
      target = matches[0] || findByName(name)[0];
    }
    if (!target) return { content: [{ type: 'text', text: `Page "${name}" not found` }] };
    const tree = printTree(target.id, depth);
    return { content: [{ type: 'text', text: `Page: ${target.name} (${target.id})\n\n${tree}` }] };
  }
);

// Tool: node detail
server.tool(
  'figma_node',
  'Inspect a node with CSS properties and tree structure',
  { query: z.string().describe('Node name or ID') },
  async ({ query }) => {
    const err = requireScenegraph();
    if (err) return err;
    let target = findById(query);
    if (!target) {
      const matches = findByName(query);
      target = matches[0];
    }
    if (!target) return { content: [{ type: 'text', text: `Node "${query}" not found` }] };

    const css = extractCSSFromKiwi(target.raw);
    const page = findPageFor(target.id);
    const tree = printTree(target.id, 5);

    let out = `Node: ${target.name} (${target.id}) [${target.type}]\n`;
    if (page) out += `Page: ${page.name}\n`;
    if (Object.keys(css).length > 0) {
      out += '\nCSS:\n';
      for (const [k, v] of Object.entries(css)) out += `  ${k}: ${v}\n`;
    }
    out += `\nTree:\n${tree}`;
    return { content: [{ type: 'text', text: out }] };
  }
);

// Tool: search
server.tool(
  'figma_search',
  'Search nodes by name across all pages',
  { pattern: z.string().describe('Search pattern (case-insensitive)') },
  async ({ pattern }) => {
    const err = requireScenegraph();
    if (err) return err;
    const matches = findByName(pattern);
    if (matches.length === 0) return { content: [{ type: 'text', text: `No matches for "${pattern}"` }] };
    const lines = matches.map(n => {
      const vis = n.visible ? '' : ' [hidden]';
      return `[${n.type}] ${n.name} (${n.id})${vis}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Tool: CSS
server.tool(
  'figma_css',
  'Extract CSS properties from a node',
  { query: z.string().describe('Node name or ID') },
  async ({ query }) => {
    const err = requireScenegraph();
    if (err) return err;
    let target = findById(query);
    if (!target) target = findByName(query)[0];
    if (!target) return { content: [{ type: 'text', text: `Node "${query}" not found` }] };

    const css = extractCSSFromKiwi(target.raw);
    return { content: [{ type: 'text', text: JSON.stringify(css, null, 2) }] };
  }
);

// Tool: texts
server.tool(
  'figma_texts',
  'Extract all text content from a page or subtree',
  { name: z.string().describe('Page name or node ID') },
  async ({ name }) => {
    const err = requireScenegraph();
    if (err) return err;
    const nodes = getNodes();
    let target = findById(name);
    if (!target) target = findByName(name).filter(n => n.type === 'CANVAS')[0] || findByName(name)[0];
    if (!target) return { content: [{ type: 'text', text: `"${name}" not found` }] };

    const texts = [];
    function walk(nid) {
      const n = nodes.get(nid);
      if (!n) return;
      if (n.type === 'TEXT' && n.raw.textData?.characters) {
        texts.push({ id: nid, name: n.name, text: n.raw.textData.characters });
      }
      for (const cid of n.children) walk(cid);
    }
    walk(target.id);

    const lines = texts.map(t => `[${t.id}] ${t.name}: ${t.text.slice(0, 120)}`);
    return { content: [{ type: 'text', text: lines.join('\n') || 'No text nodes found' }] };
  }
);

// Tool: components
server.tool(
  'figma_components',
  'List all component sets and standalone components',
  { pattern: z.string().optional().describe('Filter by name (optional)') },
  async ({ pattern }) => {
    const err = requireScenegraph();
    if (err) return err;
    const nodes = getNodes();
    const pm = getParentMap();

    const re = pattern ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const lines = [];

    // Find SYMBOL nodes grouped by parent
    const setChildren = new Map();
    const standalone = [];
    for (const [nid, n] of nodes) {
      if (n.type !== 'SYMBOL') continue;
      const pid = pm.get(nid);
      if (pid && nodes.get(pid)?.type === 'FRAME') {
        if (!setChildren.has(pid)) setChildren.set(pid, []);
        setChildren.get(pid).push(nid);
      } else {
        standalone.push(nid);
      }
    }

    for (const [pid, children] of setChildren) {
      if (children.length < 2) { standalone.push(...children); continue; }
      const parent = nodes.get(pid);
      if (re && !re.test(parent.name)) continue;
      lines.push(`${parent.name} (${pid}) — ${children.length} variants`);
    }

    for (const nid of standalone) {
      const n = nodes.get(nid);
      if (re && !re.test(n.name)) continue;
      lines.push(`${n.name} (${nid}) [standalone]`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') || 'No components found' }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
