// Decode Figma's binary vector formats into SVG paths.
// Pure functions — takes binary buffers, returns SVG strings.
//
// Figma stores vector geometry in two binary formats:
//
// 1. commandsBlob — pre-computed SVG-like path commands:
//    01 = MoveTo (2 x float32)
//    02 = LineTo (2 x float32)
//    03 = ClosePath
//    04 = CubicBezier (6 x float32)
//
// 2. vectorNetworkBlob — the original editable path data:
//    Header: vertexCount(u32) segmentCount(u32) regionCount(u32)
//    Per vertex: flags(u32) x(f32) y(f32) = 12 bytes
//    Per segment: flags(u32) startIdx(u32) tsx(f32) tsy(f32) endIdx(u32) tex(f32) tey(f32) = 28 bytes

/**
 * Decode a commandsBlob buffer into an SVG path `d` attribute string.
 *
 * @param {Uint8Array} bytes - Raw commandsBlob binary data
 * @returns {string|null} SVG path data string, or null if empty/invalid
 */
export function commandsBlobToPath(bytes) {
  if (!bytes || bytes.length === 0) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const parts = [];

  while (pos < bytes.length) {
    const cmd = bytes[pos]; pos++;
    if (cmd === 0) continue; // subpath separator
    if (cmd === 1) { // MoveTo
      const x = view.getFloat32(pos, true); pos += 4;
      const y = view.getFloat32(pos, true); pos += 4;
      parts.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else if (cmd === 2) { // LineTo
      const x = view.getFloat32(pos, true); pos += 4;
      const y = view.getFloat32(pos, true); pos += 4;
      parts.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else if (cmd === 4) { // CubicBezier
      const x1 = view.getFloat32(pos, true); pos += 4;
      const y1 = view.getFloat32(pos, true); pos += 4;
      const x2 = view.getFloat32(pos, true); pos += 4;
      const y2 = view.getFloat32(pos, true); pos += 4;
      const x = view.getFloat32(pos, true); pos += 4;
      const y = view.getFloat32(pos, true); pos += 4;
      parts.push(`C ${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}`);
    } else if (cmd === 3) { // ClosePath
      parts.push('Z');
    } else {
      break; // Unknown command
    }
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Decode a vectorNetworkBlob into an SVG path `d` attribute string.
 * This is the original editable path (before Figma expands it to commandsBlob).
 *
 * @param {Uint8Array} bytes - Raw vectorNetworkBlob binary data
 * @returns {string|null} SVG path data string, or null if invalid/too complex
 */
export function vectorNetworkBlobToPath(bytes) {
  if (!bytes || bytes.length < 12) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const vc = view.getUint32(pos, true); pos += 4;
  const sc = view.getUint32(pos, true); pos += 4;
  const rc = view.getUint32(pos, true); pos += 4;

  if (vc === 0 || sc === 0) return null;

  // Vertices: 12 bytes each (flags(u32) + x(f32) + y(f32))
  const verts = [];
  for (let i = 0; i < vc; i++) {
    if (pos + 12 > bytes.length) return null;
    pos += 4; // skip flags
    const x = view.getFloat32(pos, true); pos += 4;
    const y = view.getFloat32(pos, true); pos += 4;
    verts.push({ x, y });
  }

  // Segments: 28 bytes each
  const segs = [];
  for (let i = 0; i < sc; i++) {
    if (pos + 28 > bytes.length) return null;
    pos += 4; // skip flags
    const start = view.getUint32(pos, true); pos += 4;
    const tsx = view.getFloat32(pos, true); pos += 4;
    const tsy = view.getFloat32(pos, true); pos += 4;
    const end = view.getUint32(pos, true); pos += 4;
    const tex = view.getFloat32(pos, true); pos += 4;
    const tey = view.getFloat32(pos, true); pos += 4;
    if (start >= vc || end >= vc) return null;
    segs.push({ start, end, tsx, tsy, tex, tey });
  }

  // Regions: each has windingRule(u32), loopCount(u32), then per loop:
  // segmentIndexCount(u32) + segmentIndexCount × u32
  // If regions exist, use them to order segments into proper loops.
  // Otherwise, fall back to sequential segment ordering.
  const loops = []; // array of arrays of segment indices
  for (let r = 0; r < rc; r++) {
    if (pos + 8 > bytes.length) break;
    pos += 4; // skip winding rule
    const loopCount = view.getUint32(pos, true); pos += 4;
    for (let l = 0; l < loopCount; l++) {
      if (pos + 4 > bytes.length) break;
      const segIdxCount = view.getUint32(pos, true); pos += 4;
      const loop = [];
      for (let s = 0; s < segIdxCount; s++) {
        if (pos + 4 > bytes.length) break;
        loop.push(view.getUint32(pos, true)); pos += 4;
      }
      loops.push(loop);
    }
  }

  function segToPath(seg) {
    const v0 = verts[seg.start];
    const v1 = verts[seg.end];
    const isCurve = (Math.abs(seg.tsx) > 0.001 || Math.abs(seg.tsy) > 0.001 ||
                     Math.abs(seg.tex) > 0.001 || Math.abs(seg.tey) > 0.001);
    if (isCurve) {
      return `C ${(v0.x+seg.tsx).toFixed(2)} ${(v0.y+seg.tsy).toFixed(2)} ${(v1.x+seg.tex).toFixed(2)} ${(v1.y+seg.tey).toFixed(2)} ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`;
    }
    return `L ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`;
  }

  const parts = [];

  if (loops.length > 0) {
    // Use region loops for proper segment ordering
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const si = loop[i];
        if (si >= segs.length) continue;
        const seg = segs[si];
        if (i === 0) {
          parts.push(`M ${verts[seg.start].x.toFixed(2)} ${verts[seg.start].y.toFixed(2)}`);
        }
        parts.push(segToPath(seg));
      }
      parts.push('Z');
    }
  } else {
    // No regions — fall back to sequential ordering
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      if (si === 0 || parts[parts.length - 1] === 'Z') {
        parts.push(`M ${verts[seg.start].x.toFixed(2)} ${verts[seg.start].y.toFixed(2)}`);
      }
      parts.push(segToPath(seg));
    }
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Convert a Figma color object {r, g, b, a} (0-1 floats) to hex string.
 */
export function colorToHex(c) {
  if (!c) return '#000000';
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Extract all VECTOR nodes from a decoded page as SVG strings.
 *
 * @param {object} decoded - Decoded Kiwi Message (has nodeChanges + blobs)
 * @returns {Map<string, {name: string, type: string, svg: string, w: number, h: number}>}
 */
export function extractSvgs(decoded) {
  const blobs = decoded.blobs || [];
  const results = new Map();

  for (const nc of decoded.nodeChanges || []) {
    if (!nc.fillGeometry?.length && !nc.strokeGeometry?.length) continue;

    const nid = `${nc.guid?.sessionID || 0}:${nc.guid?.localID || 0}`;
    if (results.has(nid)) continue;

    const w = nc.size?.x || 0;
    const h = nc.size?.y || 0;
    if (w === 0 || h === 0) continue;

    const paths = [];

    // Fill paths — skip emitting any fill path when fillPaints is non-empty
    // but all its entries are visible:false (Figma still emits a bounding-box
    // fillGeometry for FRAMEs with hidden backgrounds; rendering it as solid
    // black was producing a black square for icon containers like
    // simple-icons:beatport). We keep the #000000 fallback only when
    // fillPaints is absent entirely — some bare VECTORs carry no paint
    // metadata and historically rendered as black.
    const fillPaints = nc.fillPaints || [];
    const visibleFills = fillPaints.filter(p => p.visible !== false && p.type === 'SOLID');
    // Skip the fill path when every paint (SOLID or otherwise) is hidden.
    // GRADIENT/IMAGE paints that are visible are not rendered yet but we
    // still emit the black fallback path for them (prior behavior) — the
    // concrete bug fix here is just the all-hidden case.
    const allFillsHidden = fillPaints.length > 0 && !fillPaints.some(p => p.visible !== false);
    if (!allFillsHidden) {
      for (const fg of nc.fillGeometry || []) {
        const blobIdx = fg.commandsBlob;
        if (typeof blobIdx === 'number' && blobs[blobIdx]?.bytes) {
          const d = commandsBlobToPath(blobs[blobIdx].bytes);
          if (d) {
            let fill = '#000000';
            let fillOpacity = '';
            if (visibleFills.length > 0) {
              fill = colorToHex(visibleFills[0].color);
              const op = visibleFills[0].opacity ?? 1;
              if (op < 1) fillOpacity = ` fill-opacity="${op.toFixed(2)}"`;
            }
            paths.push(`<path d="${d}" fill="${fill}"${fillOpacity} fill-rule="${fg.windingRule === 'ODD' ? 'evenodd' : 'nonzero'}"/>`);
          }
        }
      }
    }

    // Stroke paths. Mirroring the fill logic: when strokePaints is non-empty
    // but every entry is visible:false, skip stroke emission entirely (do not
    // fall back to #000000). The bare-VECTOR / absent-strokePaints case keeps
    // the historical #000000 fallback — some nodes carry strokeGeometry with
    // no strokePaints metadata and previously rendered as black.
    const strokePaints = nc.strokePaints || [];
    const visibleStrokes = strokePaints.filter(p => p.visible !== false && p.type === 'SOLID');
    const allStrokesHidden = strokePaints.length > 0 && !strokePaints.some(p => p.visible !== false);

    const isStrokeOnly = !nc.fillGeometry?.length && nc.strokeGeometry?.length > 0;
    if (!allStrokesHidden && isStrokeOnly && nc.vectorData?.vectorNetworkBlob !== undefined) {
      const vnIdx = nc.vectorData.vectorNetworkBlob;
      let vnPath = null;
      if (typeof vnIdx === 'number' && blobs[vnIdx]?.bytes) {
        vnPath = vectorNetworkBlobToPath(blobs[vnIdx].bytes);
      }
      if (vnPath) {
        let stroke = '#000000';
        if (visibleStrokes.length > 0) stroke = colorToHex(visibleStrokes[0].color);
        const sw = nc.strokeWeight || 1;
        const cap = nc.strokeCap === 'ROUND' ? 'round' : nc.strokeCap === 'SQUARE' ? 'square' : 'butt';
        const join = nc.strokeJoin === 'ROUND' ? 'round' : nc.strokeJoin === 'BEVEL' ? 'bevel' : 'miter';
        paths.push(`<path d="${vnPath}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="${cap}" stroke-linejoin="${join}"/>`);
      } else {
        for (const sg of nc.strokeGeometry || []) {
          const blobIdx = sg.commandsBlob;
          if (typeof blobIdx === 'number' && blobs[blobIdx]?.bytes) {
            const d = commandsBlobToPath(blobs[blobIdx].bytes);
            if (d) {
              let stroke = '#000000';
              if (visibleStrokes.length > 0) stroke = colorToHex(visibleStrokes[0].color);
              paths.push(`<path d="${d}" fill="${stroke}"/>`);
            }
          }
        }
      }
    }
    if (!allStrokesHidden && !isStrokeOnly) {
      for (const sg of nc.strokeGeometry || []) {
        const blobIdx = sg.commandsBlob;
        if (typeof blobIdx === 'number' && blobs[blobIdx]?.bytes) {
          const d = commandsBlobToPath(blobs[blobIdx].bytes);
          if (d) {
            let stroke = '#000000';
            if (visibleStrokes.length > 0) stroke = colorToHex(visibleStrokes[0].color);
            paths.push(`<path d="${d}" fill="${stroke}"/>`);
          }
        }
      }
    }

    if (paths.length > 0) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">\n  ${paths.join('\n  ')}\n</svg>`;
      results.set(nid, { name: nc.name || '', type: nc.type, svg, w, h });
    }
  }

  return results;
}

/**
 * Compose an inline-ready SVG icon from a container node and its children.
 *
 * Supported container types: SYMBOL (original, backward-compatible behavior),
 * FRAME, INSTANCE. For SYMBOL, child fills #ffffff/#fff are rewritten to
 * currentColor and the root <svg> carries fill="currentColor" so the icon
 * inherits text color. For FRAME/INSTANCE (iconify-style containers such as
 * `simple-icons:beatport`), child fills are preserved verbatim and the
 * container's own visible fillGeometry (e.g. a rounded-rect background) is
 * included as the first painted layer.
 *
 * Each child is positioned via its relativeTransform. When the matrix is a
 * pure translation we emit the readable `translate(tx, ty)` form (round-trips
 * cleanly). Otherwise we emit the full `matrix(m00 m10 m01 m11 m02 m12)` form
 * so that scale/rotate/mirror are preserved — this is needed for things like
 * horizontally-flipped icons (forward-arrow from a mirrored back-arrow).
 *
 * Child transform is supplied as `{ m00, m01, m02, m10, m11, m12 }` (Figma's
 * 2x3 affine layout). For backward compat the legacy `{ x, y }` shape is
 * still accepted and treated as a pure translate.
 *
 * @param {object} containerNode - The parent nodeChange (SYMBOL/FRAME/INSTANCE)
 * @param {object[]} childNodes - Array of { node, transform } for each child
 * @param {function} getSvgFile - (nodeId) => SVG file content string, or null
 * @returns {string|null} Composed <svg> string, or null if no paths found
 */
export function composeSvgIcon(containerNode, childNodes, getSvgFile) {
  const size = containerNode.size || {};
  const w = size.x || 0;
  const h = size.y || 0;
  if (w === 0 || h === 0) return null;

  const type = containerNode.type;
  // Default treatment mirrors the original SYMBOL behavior. FRAME/INSTANCE
  // preserve original child fills and include the container's own fill
  // geometry when it has visible paints (e.g. rounded-rect backgrounds).
  const isSymbol = type === 'SYMBOL';
  const recolorWhite = isSymbol;
  const includeContainerFill = !isSymbol;

  // Figma's "clip content" flag is stored as `frameMaskDisabled` (inverted).
  // frameMaskDisabled === false  ⇔  clipsContent === true
  // We only emit an SVG <clipPath> when clipping is enabled AND the container
  // has a visible background geometry (a rounded-rect fill is the usual
  // iconify-pill case — Apple Music's #FF0051 glyph is clipped to the 24x24
  // rx=6 white rect). A FRAME with clipping enabled but no visible background
  // (e.g. simple-icons:beatport, whose container fill is `visible:false`) is
  // purely a layout container and needs no clipPath in the exported SVG.
  const clipsContent = !isSymbol && containerNode.frameMaskDisabled === false;

  const groups = [];
  // Self-fill paths from the container's own pre-extracted SVG. Captured
  // separately so we can re-use them both as the visible background AND as
  // the clipPath geometry below.
  const selfPaths = [];

  // Container self-fill (FRAME/INSTANCE only): extract <path> elements from
  // the container's own pre-extracted SVG file (which extractSvgs emits
  // when the container has visible fills). We intentionally skip this for
  // SYMBOL to preserve backward-compatible output.
  if (includeContainerFill) {
    const g = containerNode.guid || {};
    const selfNid = `${g.sessionID || 0}:${g.localID || 0}`;
    const selfSvg = getSvgFile(selfNid);
    if (selfSvg) {
      const pathRe = /<path\b[^>]*\/>/g;
      let m;
      while ((m = pathRe.exec(selfSvg)) !== null) {
        selfPaths.push(m[0]);
      }
    }
  }
  // Visible background is painted first; clipPath (if any) uses the same
  // geometry but stripped of paint attributes.
  groups.push(...selfPaths);

  for (const { node, transform } of childNodes) {
    const g = node.guid || {};
    const nid = `${g.sessionID || 0}:${g.localID || 0}`;
    const svgContent = getSvgFile(nid);
    if (!svgContent) continue;

    // Extract <path> elements from the child SVG file.
    const paths = [];
    const pathRe = /<path\b[^>]*\/>/g;
    let m;
    while ((m = pathRe.exec(svgContent)) !== null) {
      let path = m[0];
      if (recolorWhite) {
        path = path
          .replace(/#ffffff/gi, 'currentColor')
          .replace(/#fff(?=[^a-fA-F0-9])/gi, 'currentColor');
      }
      paths.push(path);
    }
    if (paths.length === 0) continue;

    // Accept either a full 2x3 affine {m00..m12} (preferred) or the legacy
    // {x, y} pure-translate form.
    const hasMatrix = transform && (
      transform.m00 !== undefined || transform.m11 !== undefined ||
      transform.m01 !== undefined || transform.m10 !== undefined ||
      transform.m02 !== undefined || transform.m12 !== undefined
    );
    const m00 = hasMatrix ? (transform.m00 ?? 1) : 1;
    const m01 = hasMatrix ? (transform.m01 ?? 0) : 0;
    const m10 = hasMatrix ? (transform.m10 ?? 0) : 0;
    const m11 = hasMatrix ? (transform.m11 ?? 1) : 1;
    const m02 = hasMatrix ? (transform.m02 ?? 0) : (transform?.x || 0);
    const m12 = hasMatrix ? (transform.m12 ?? 0) : (transform?.y || 0);

    // Small epsilon — Figma emits values like 8.74e-8 for 90/180° rotations
    // that are conceptually zero. 1e-6 is loose enough to catch those while
    // still flagging intentional near-identity scales as non-translate.
    const EPS = 1e-6;
    const isPureTranslate = (
      Math.abs(m00 - 1) < EPS &&
      Math.abs(m11 - 1) < EPS &&
      Math.abs(m01) < EPS &&
      Math.abs(m10) < EPS
    );

    const opacity = node.opacity;
    const opAttr = (opacity != null && opacity !== 1) ? ` opacity="${opacity}"` : '';

    if (isPureTranslate) {
      if (m02 === 0 && m12 === 0 && !opAttr) {
        groups.push(...paths);
      } else {
        groups.push(`<g transform="translate(${m02}, ${m12})"${opAttr}>${paths.join('')}</g>`);
      }
    } else {
      // SVG matrix(a b c d e f) = [[a c e], [b d f]] = Figma [[m00 m01 m02], [m10 m11 m12]]
      // so the argument order is m00 m10 m01 m11 m02 m12.
      groups.push(`<g transform="matrix(${m00} ${m10} ${m01} ${m11} ${m02} ${m12})"${opAttr}>${paths.join('')}</g>`);
    }
  }

  if (groups.length === 0) return null;

  const rootFillAttr = isSymbol ? ' fill="currentColor"' : '';

  // Only emit a <clipPath> when clipping is enabled AND we actually have
  // container geometry to clip against — a clipPath with no children is a
  // no-op and would add bytes for nothing.
  const emitClip = clipsContent && selfPaths.length > 0;
  if (emitClip) {
    const g = containerNode.guid || {};
    const selfNid = `${g.sessionID || 0}:${g.localID || 0}`;
    // Deterministic id derived from the container node id so multiple
    // composed icons in one sprite don't collide. `:` is not valid in
    // SVG ids, so we swap it for `_`.
    const clipId = `clip-${selfNid.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    // Build the clipPath body: drop fill/stroke attributes from the self
    // paths — inside a <clipPath> paint attributes are ignored, and
    // stripping them keeps the DOM honest and diff-friendly.
    const clipPaths = selfPaths.map(p =>
      p.replace(/\s(fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-opacity)="[^"]*"/g, '')
    );
    // The first `selfPaths.length` entries in `groups` are the self-fill
    // paths that must remain visible (e.g. the white background rect).
    // The remaining entries are the child groups we want to clip.
    const visibleSelf = groups.slice(0, selfPaths.length);
    const children = groups.slice(selfPaths.length);
    const wrapped = [
      `<g clip-path="url(#${clipId})">`,
      ...visibleSelf,
      ...children,
      `</g>`,
      `<defs><clipPath id="${clipId}">${clipPaths.join('')}</clipPath></defs>`,
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${rootFillAttr}>\n  ${wrapped.join('\n  ')}\n</svg>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${rootFillAttr}>\n  ${groups.join('\n  ')}\n</svg>`;
}

/**
 * Compose two Figma 2x3 affine transforms: `out = parent ∘ child` so the
 * child's local-space coordinates land in the grandparent's coordinate
 * system after we collapse a pass-through wrapper FRAME / BOOLEAN_OPERATION
 * out of the tree.
 *
 * Either argument may be null/undefined (treated as identity). Missing matrix
 * cells default to the identity values (m00/m11 = 1, others = 0).
 */
export function composeAffine2x3(parent, child) {
  const pa = parent || {};
  const ca = child || {};
  const p00 = pa.m00 ?? 1, p01 = pa.m01 ?? 0, p02 = pa.m02 ?? 0;
  const p10 = pa.m10 ?? 0, p11 = pa.m11 ?? 1, p12 = pa.m12 ?? 0;
  const c00 = ca.m00 ?? 1, c01 = ca.m01 ?? 0, c02 = ca.m02 ?? 0;
  const c10 = ca.m10 ?? 0, c11 = ca.m11 ?? 1, c12 = ca.m12 ?? 0;
  return {
    m00: p00 * c00 + p01 * c10,
    m01: p00 * c01 + p01 * c11,
    m02: p00 * c02 + p01 * c12 + p02,
    m10: p10 * c00 + p11 * c10,
    m11: p10 * c01 + p11 * c11,
    m12: p10 * c02 + p11 * c12 + p12,
  };
}

/**
 * Recursively flatten a subtree into a list of `{ node, transform }` pairs
 * for every descendant that has an extractable SVG. Pass-through wrapper
 * containers (Group FRAMEs without own paint, BOOLEAN_OPERATIONs whose
 * outline lives at the boolean node itself or further down) are collapsed
 * and their transform folded into the descendants.
 *
 * We stop descending as soon as a node satisfies `hasExtractedSvg(nid)` —
 * that includes BOOLEAN_OPERATION nodes whose composite outline was emitted
 * by extractSvgs (e.g. Subtract for skill-icons:instagram).
 *
 * Starts from a single child id with an initial accumulated transform
 * (typically null, meaning identity). Appends results into `out`.
 *
 * @param {Map<string, object>} tree - Tree from buildTree()
 * @param {string} cid - Root child id to start flattening from
 * @param {object|null} accumulated - Accumulated 2x3 affine from ancestors
 * @param {{node: object, transform: object}[]} out - Accumulator array
 * @param {function(string): boolean} hasExtractedSvg - Predicate: does this
 *   node id have a standalone extracted SVG? Typically
 *   `(nid) => !!svgIndex[nid]`.
 */
export function flattenIconDescendants(tree, cid, accumulated, out, hasExtractedSvg) {
  const c = tree.get(cid);
  if (!c) return;
  const local = c.raw.transform || {};
  const cumulative = composeAffine2x3(accumulated, local);
  if (hasExtractedSvg(cid)) {
    out.push({ node: c.raw, transform: cumulative });
    return;
  }
  if ((c.type === 'FRAME' || c.type === 'INSTANCE' || c.type === 'BOOLEAN_OPERATION')
      && c.children?.length) {
    for (const gcid of c.children) {
      flattenIconDescendants(tree, gcid, cumulative, out, hasExtractedSvg);
    }
  }
}

/**
 * FRAME/INSTANCE composition pass — iconify-style containers (e.g.
 * `simple-icons:beatport`) hold the visible glyph in a child VECTOR while
 * the FRAME itself only carries a hidden bounding-box fill. Per-node SVG
 * extraction emits the child VECTOR correctly but a consumer looking up the
 * container id sees only the (now-empty) FRAME. This pass rewrites those
 * entries to a composed SVG that includes the child geometry at its
 * relative transform.
 *
 * The heuristic is tight on purpose: we only compose when at least one
 * DIRECT child is either (a) a VECTOR/BOOLEAN_OPERATION with an extracted
 * SVG, or (b) a single-wrapper Group FRAME whose direct children include
 * such a node. This matches historical behavior and prevents rewriting
 * generic layout FRAMEs as composed icons. The one deliberate extension
 * is recursing through the wrapper to pick up deeply-nested cases like
 * `FRAME → FRAME → BOOLEAN_OPERATION → VECTOR×3` (skill-icons:instagram).
 *
 * This function is pure orchestration over the tree and a caller-supplied
 * getSvgFile — all I/O (reading svg files, writing the composed output) is
 * the caller's responsibility. Results are delivered via `onComposed`,
 * which receives `(nid, svg, containerNode, treeNode)`.
 *
 * @param {Map<string, object>} tree - Tree from buildTree()
 * @param {object} opts
 * @param {function(string): boolean} opts.hasExtractedSvg - Predicate
 * @param {function(string): string|null} opts.getSvgFile - Resolve node id
 *   to raw SVG file content (or null if not available)
 * @param {function(string, string, object, object): void} opts.onComposed -
 *   Callback per composed container. Called with (nid, composedSvg,
 *   containerNode, treeNode).
 * @returns {number} Count of composed containers
 */
export function composeIconContainers(tree, { hasExtractedSvg, getSvgFile, onComposed }) {
  let composed = 0;
  for (const [nid, treeNode] of tree) {
    if (treeNode.type !== 'FRAME' && treeNode.type !== 'INSTANCE') continue;
    if (!treeNode.children?.length) continue;

    const hasExtractableDirectChild = treeNode.children.some(cid => {
      const c = tree.get(cid);
      if (!c) return false;
      if (c.type === 'VECTOR' && hasExtractedSvg(cid)) return true;
      if (c.type === 'BOOLEAN_OPERATION' && hasExtractedSvg(cid)) return true;
      // Nested Group FRAME whose subtree contains a VECTOR/BOOLEAN_OPERATION
      // with SVG counts too — but we require exactly one non-painted FRAME
      // wrapper to keep the heuristic tight.
      if (c.type === 'FRAME' && !hasExtractedSvg(cid) && c.children?.length) {
        return c.children.some(gcid => {
          const gc = tree.get(gcid);
          return gc && (gc.type === 'VECTOR' || gc.type === 'BOOLEAN_OPERATION')
            && hasExtractedSvg(gcid);
        });
      }
      return false;
    });
    if (!hasExtractableDirectChild) continue;

    // Gather descendant SVG-bearing nodes with accumulated transforms.
    const childNodes = [];
    for (const cid of treeNode.children) {
      flattenIconDescendants(tree, cid, null, childNodes, hasExtractedSvg);
    }
    if (childNodes.length === 0) continue;

    const containerNc = treeNode.raw;
    const svg = composeSvgIcon(containerNc, childNodes, getSvgFile);
    if (!svg) continue;

    onComposed(nid, svg, containerNc, treeNode);
    composed++;
  }
  return composed;
}
