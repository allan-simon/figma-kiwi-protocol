// Pure helpers for working with Figma's comments REST endpoint.
// The actual fetch lives in `bin/comments.mjs` (needs auth — token or
// CDP-cookies); this file only reshapes the JSON the server returns
// so callers can render threads or join comments to scenegraph nodes
// without hand-rolling the parent_id walk every time.

/**
 * Group a flat comments array (each entry has `id` and `parent_id`)
 * into thread roots with replies attached. Thread root = a comment
 * whose `parent_id` is null OR points to a non-existent comment
 * (Figma keeps replies pinned to the original even when the root is
 * deleted).
 *
 * @param {Array<Object>} comments — `meta` array from the comments API.
 * @returns {Array<Object>} thread roots, each with a `replies` field
 *   sorted by `created_at` ascending.
 */
export function buildThreads(comments) {
  if (!Array.isArray(comments)) return [];
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);

  const roots = [];
  const repliesByParent = new Map();

  for (const c of comments) {
    const pid = c.parent_id;
    if (!pid || !byId.has(pid)) {
      roots.push({ ...c, replies: [] });
    } else {
      if (!repliesByParent.has(pid)) repliesByParent.set(pid, []);
      repliesByParent.get(pid).push(c);
    }
  }

  // Sort roots and replies by created_at so callers can render in
  // chronological order without re-sorting.
  const byCreated = (a, b) => (a.created_at || '').localeCompare(b.created_at || '');
  roots.sort(byCreated);
  for (const root of roots) {
    const replies = repliesByParent.get(root.id) || [];
    replies.sort(byCreated);
    root.replies = replies;
  }
  return roots;
}

/**
 * Normalise a single comment into a flat shape suited to grep / JSON
 * pipelines. Absolute canvas coords and node-local offset are both
 * passed through verbatim — Figma ships both, the consumer picks.
 *
 * @param {Object} c — one element from the comments API `meta` array.
 * @returns {Object} flattened comment.
 */
export function flattenComment(c) {
  const cm = c.client_meta || {};
  return {
    id: c.id,
    parent_id: c.parent_id || null,
    user: c.user?.handle ?? null,
    created_at: c.created_at,
    resolved_at: c.resolved_at || null,
    message: c.message,
    page_id: cm.page_id ?? null,
    node_id: cm.node_id ?? null,
    node_offset: cm.node_offset ?? null,
    canvas_xy: cm.x !== undefined && cm.y !== undefined
      ? { x: cm.x, y: cm.y }
      : null,
    in_frame: cm.in_frame ?? null,
    stable_path: cm.stable_path ?? null,
  };
}

/**
 * Join a comment to scenegraph metadata: the anchor node's name +
 * type, plus the chain of enclosing FRAME/CANVAS ancestors. Useful
 * for "show me all comments inside the Editeur/Flyer page" queries
 * without the consumer reaching into the scenegraph by hand.
 *
 * `nodeIndex` is a `Map<id, {name, type, parent_id?}>` the caller
 * builds from their decoded scenegraph. Implementations vary
 * (kiwi-decoded vs REST-decoded), so we don't ship a builder here.
 *
 * @param {Object} comment — already-flattened comment (see above).
 * @param {Map<string, {name, type, parent_id?}>} nodeIndex
 * @returns {Object} comment augmented with `node_name`, `node_type`,
 *   and `ancestors` (array of {id, name, type} from page → leaf).
 */
export function joinToScenegraph(comment, nodeIndex) {
  const out = { ...comment, node_name: null, node_type: null, ancestors: [] };
  if (!comment.node_id || !nodeIndex) return out;

  const anchor = nodeIndex.get(comment.node_id);
  if (anchor) {
    out.node_name = anchor.name ?? null;
    out.node_type = anchor.type ?? null;
  }

  // Walk parent chain. We accept either `parent_id` on each node
  // (typical scenegraph builds) or a `stable_path` already on the
  // comment (Figma includes it). Prefer `stable_path` when present —
  // it's authoritative even when the scenegraph snapshot is partial.
  const path = Array.isArray(comment.stable_path) && comment.stable_path.length > 0
    ? comment.stable_path
    : walkParents(comment.node_id, nodeIndex);

  for (const id of path) {
    const n = nodeIndex.get(id);
    if (n) out.ancestors.push({ id, name: n.name ?? null, type: n.type ?? null });
    else out.ancestors.push({ id, name: null, type: null });
  }
  return out;
}

function walkParents(id, nodeIndex) {
  const chain = [];
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    const n = nodeIndex.get(cur);
    cur = n?.parent_id;
  }
  return chain;
}
