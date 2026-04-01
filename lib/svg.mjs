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
  if (!bytes || bytes.length < 2) return null;

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

  if (vc > 200 || sc > 200) return null; // too complex

  // Vertices: 12 bytes each (flags(u32) + x(f32) + y(f32))
  const verts = [];
  for (let i = 0; i < vc; i++) {
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

  if (segs.length === 0) return null;

  // Build SVG path by following segments
  const used = new Set();
  const parts = [];

  for (let si = 0; si < segs.length; si++) {
    if (used.has(si)) continue;
    used.add(si);
    const seg = segs[si];
    const v0 = verts[seg.start];
    const v1 = verts[seg.end];

    if (parts.length === 0 || parts[parts.length - 1].endsWith('Z')) {
      parts.push(`M ${v0.x.toFixed(2)} ${v0.y.toFixed(2)}`);
    }

    const isCurve = (Math.abs(seg.tsx) > 0.001 || Math.abs(seg.tsy) > 0.001 ||
                     Math.abs(seg.tex) > 0.001 || Math.abs(seg.tey) > 0.001);
    if (isCurve) {
      const cp1x = v0.x + seg.tsx;
      const cp1y = v0.y + seg.tsy;
      const cp2x = v1.x + seg.tex;
      const cp2y = v1.y + seg.tey;
      parts.push(`C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`);
    } else {
      parts.push(`L ${v1.x.toFixed(2)} ${v1.y.toFixed(2)}`);
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

    // Fill paths
    for (const fg of nc.fillGeometry || []) {
      const blobIdx = fg.commandsBlob;
      if (typeof blobIdx === 'number' && blobs[blobIdx]?.bytes) {
        const d = commandsBlobToPath(blobs[blobIdx].bytes);
        if (d) {
          let fill = '#000000';
          let fillOpacity = '';
          const fills = (nc.fillPaints || []).filter(p => p.visible !== false && p.type === 'SOLID');
          if (fills.length > 0) {
            fill = colorToHex(fills[0].color);
            const op = fills[0].opacity ?? 1;
            if (op < 1) fillOpacity = ` fill-opacity="${op.toFixed(2)}"`;
          }
          paths.push(`<path d="${d}" fill="${fill}"${fillOpacity} fill-rule="${fg.windingRule === 'ODD' ? 'evenodd' : 'nonzero'}"/>`);
        }
      }
    }

    // Stroke paths
    const isStrokeOnly = !nc.fillGeometry?.length && nc.strokeGeometry?.length > 0;
    if (isStrokeOnly && nc.vectorData?.vectorNetworkBlob !== undefined) {
      const vnIdx = nc.vectorData.vectorNetworkBlob;
      let vnPath = null;
      if (typeof vnIdx === 'number' && blobs[vnIdx]?.bytes) {
        vnPath = vectorNetworkBlobToPath(blobs[vnIdx].bytes);
      }
      if (vnPath) {
        let stroke = '#000000';
        const strokes = (nc.strokePaints || []).filter(p => p.visible !== false && p.type === 'SOLID');
        if (strokes.length > 0) stroke = colorToHex(strokes[0].color);
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
              const strokes = (nc.strokePaints || []).filter(p => p.visible !== false && p.type === 'SOLID');
              if (strokes.length > 0) stroke = colorToHex(strokes[0].color);
              paths.push(`<path d="${d}" fill="${stroke}"/>`);
            }
          }
        }
      }
    }
    if (!isStrokeOnly) {
      for (const sg of nc.strokeGeometry || []) {
        const blobIdx = sg.commandsBlob;
        if (typeof blobIdx === 'number' && blobs[blobIdx]?.bytes) {
          const d = commandsBlobToPath(blobs[blobIdx].bytes);
          if (d) {
            let stroke = '#000000';
            const strokes = (nc.strokePaints || []).filter(p => p.visible !== false && p.type === 'SOLID');
            if (strokes.length > 0) stroke = colorToHex(strokes[0].color);
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
