// Decode and merge Figma scenegraph data from Kiwi-encoded binary frames.
// Pure functions — takes buffers and a decoder, returns structured data.

/**
 * Decode a single page's scenegraph data.
 *
 * @param {Uint8Array} data - Decompressed Kiwi message bytes
 * @param {object} decoder - Generated Kiwi decoder (has decodeMessage())
 * @returns {object} Decoded Message with nodeChanges array
 */
export function decodePage(data, decoder) {
  return decoder.decodeMessage(new Uint8Array(data));
}

/**
 * Build a Figma-style node ID string from a guid object.
 */
export function nodeId(guid) {
  return `${guid?.sessionID || 0}:${guid?.localID || 0}`;
}

/**
 * Merge multiple decoded pages into a single scenegraph.
 * Deduplicates nodes by ID, preferring nodes with parentIndex (actually loaded).
 *
 * @param {object[]} pages - Array of decoded Message objects
 * @returns {object} Merged scenegraph with deduplicated nodeChanges
 */
export function mergePages(pages) {
  const allNodes = new Map();

  for (const page of pages) {
    for (const nc of page.nodeChanges || []) {
      const nid = nodeId(nc.guid);
      const existing = allNodes.get(nid);
      if (!existing || (nc.parentIndex && !existing.parentIndex)) {
        allNodes.set(nid, nc);
      }
    }
  }

  return {
    type: 'NODE_CHANGES',
    nodeChanges: [...allNodes.values()],
  };
}

/**
 * Build a parent-child tree from flat nodeChanges.
 *
 * @param {object} scenegraph - Merged scenegraph (has nodeChanges)
 * @returns {Map<string, object>} Map of nodeId -> tree node
 */
export function buildTree(scenegraph) {
  const nodes = new Map();

  for (const nc of scenegraph.nodeChanges || []) {
    const nid = nodeId(nc.guid);
    nodes.set(nid, {
      id: nid,
      name: nc.name || '',
      type: nc.type || 'UNKNOWN',
      visible: nc.visible !== false,
      children: [],
      raw: nc,
    });
  }

  // Wire parent-child via parentIndex
  for (const nc of scenegraph.nodeChanges || []) {
    const nid = nodeId(nc.guid);
    const pi = nc.parentIndex;
    if (!pi?.guid) continue;
    const pid = nodeId(pi.guid);
    if (pid !== nid && nodes.has(pid)) {
      nodes.get(pid).children.push({ pos: pi.position || '', id: nid });
    }
  }

  // Sort children by position
  for (const node of nodes.values()) {
    node.children.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
    node.children = node.children.map(c => c.id);
  }

  return nodes;
}

/**
 * Count nodes by type in a scenegraph.
 */
export function countByType(scenegraph) {
  const counts = {};
  for (const nc of scenegraph.nodeChanges || []) {
    const t = nc.type || 'UNKNOWN';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

/**
 * Serialize scenegraph to JSON, converting Uint8Array to placeholder strings.
 */
export function serializeScenegraph(scenegraph) {
  return JSON.stringify(scenegraph, (key, value) => {
    if (value instanceof Uint8Array) return `<binary ${value.length} bytes>`;
    if (typeof value === 'bigint') return Number(value);
    return value;
  }, 2);
}
