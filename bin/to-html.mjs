#!/usr/bin/env node
// Figma scenegraph → HTML/Tailwind generator
// Usage: figma-kiwi to-html <node_id> [--depth N] [--out file.html]
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const require = createRequire(import.meta.url);

const DIR = process.env.FIGMA_KIWI_DIR || '/tmp/figma_kiwi';
const SG_PATH = `${DIR}/scenegraph.json`;
const IMG_MAP_PATH = `${DIR}/image_mapping.json`;
const SVG_DIR = `${DIR}/svgs`;

// ─── Load data ───
const sg = JSON.parse(readFileSync(SG_PATH, 'utf8'));
const imgMap = existsSync(IMG_MAP_PATH) ? JSON.parse(readFileSync(IMG_MAP_PATH, 'utf8')) : {};
const OVERRIDE_MAP_PATH = `${DIR}/override_map.json`;
const overrideMap = existsSync(OVERRIDE_MAP_PATH) ? JSON.parse(readFileSync(OVERRIDE_MAP_PATH, 'utf8')) : {};
const NID_TO_OKEY_PATH = `${DIR}/nid_to_okey.json`;
const nidToOkey = existsSync(NID_TO_OKEY_PATH) ? JSON.parse(readFileSync(NID_TO_OKEY_PATH, 'utf8')) : {};
const PROP_ASSIGN_PATH = `${DIR}/prop_assignments.json`;
const propAssignments = existsSync(PROP_ASSIGN_PATH) ? JSON.parse(readFileSync(PROP_ASSIGN_PATH, 'utf8')) : {};
const NID_TO_PROP_DEF_PATH = `${DIR}/nid_to_prop_def.json`;
const nidToPropDef = existsSync(NID_TO_PROP_DEF_PATH) ? JSON.parse(readFileSync(NID_TO_PROP_DEF_PATH, 'utf8')) : {};

// Build node index + children
const nodesById = new Map();
const childrenOf = new Map();

for (const nc of sg.nodeChanges || []) {
  const g = nc.guid || {};
  const nid = `${g.sessionID || 0}:${g.localID || 0}`;
  nodesById.set(nid, nc);

  const pi = nc.parentIndex || {};
  const pg = pi.guid || {};
  if (pg.sessionID !== undefined) {
    const pid = `${pg.sessionID}:${pg.localID}`;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push({ pos: pi.position || '', nid });
  }
}

// Sort children by position
for (const [, children] of childrenOf) {
  children.sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
}

function getChildren(nid) {
  return (childrenOf.get(nid) || []).map(c => c.nid);
}

// ─── We also need the raw blobs for SVG extraction ───
// Load from kiwi decode if available
let blobsByPage = null; // lazy-loaded

function loadBlobsForSvg() {
  if (blobsByPage) return;
  blobsByPage = new Map();
  // We'll use the pre-extracted SVGs from svg_index instead
}

// ─── Image URL lookup ───
// We need to re-decode to get hashes. For now use the all_image_hashes.json
let hashIndex = null;
function getImageUrl(nc) {
  if (!hashIndex) {
    const p = `${DIR}/all_image_hashes.json`;
    hashIndex = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  }
  const g = nc.guid || {};
  const nid = `${g.sessionID || 0}:${g.localID || 0}`;
  // Collect all matching image URLs for this node
  const matches = [];
  for (const h of hashIndex) {
    if (h.nodes.includes(nid)) {
      const info = imgMap[h.hash];
      if (info?.url) matches.push({ url: info.url, sharedCount: h.nodes.length });
    }
  }
  if (matches.length === 0) return null;
  // Prefer the image unique to this node (least shared), as shared ones are often backgrounds
  matches.sort((a, b) => a.sharedCount - b.sharedCount);
  return matches[0].url;
}

// ─── commandsBlob → SVG path decoder ───
function blobToSvgPath(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const parts = [];
  while (pos < bytes.length) {
    const cmd = bytes[pos]; pos++;
    if (cmd === 0) {
      // Subpath separator — continue to next subpath
      continue;
    }
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
  return parts.join(' ');
}

// ─── SVG lookup ───
let svgIndex = null;
function getSvgContent(nid) {
  if (!svgIndex) {
    const p = `${DIR}/svg_index.json`;
    svgIndex = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  }
  const entry = svgIndex[nid];
  if (entry?.file) {
    const svgPath = `${SVG_DIR}/${entry.file}`;
    if (existsSync(svgPath)) return readFileSync(svgPath, 'utf8');
  }
  return null;
}

// ─── Color helpers ───
function colorToCSS(c, opacity = 1) {
  if (!c) return null;
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = (c.a ?? 1) * opacity;
  if (a < 1) return `rgba(${r},${g},${b},${a.toFixed(2)})`;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function gradientToCSS(paint) {
  const stops = paint.colorStops || [];
  if (stops.length === 0) return null;
  const parts = stops.map(s => {
    const c = colorToCSS(s.color, s.color?.a ?? 1);
    return `${c} ${(s.position * 100).toFixed(0)}%`;
  });
  return `linear-gradient(${parts.join(', ')})`;
}

// ─── Layout detection ───
function isAutoLayout(nc) {
  return nc.stackMode && nc.stackMode !== 'NONE';
}

function isAbsoluteChild(nc, parentNc, isRootChild = false) {
  // Root-level children should flow, not be absolute (page sections)
  if (isRootChild) return false;
  // If parent has auto-layout but this child has stackPositioning = ABSOLUTE
  if (nc.stackPositioning === 'ABSOLUTE') return true;
  // If parent has no auto-layout, children are absolutely positioned
  if (!isAutoLayout(parentNc)) return true;
  return false;
}

// ─── Transform → position + rotation ───
function getPosition(nc) {
  const t = nc.transform;
  if (!t) return { x: 0, y: 0 };
  return { x: t.m02 || 0, y: t.m12 || 0 };
}

function getRotation(nc) {
  const t = nc.transform;
  if (!t) return 0;
  const m00 = t.m00 ?? 1;
  const m01 = t.m01 ?? 0;
  // Figma matrix: m00=cos, m10=sin → angle = atan2(m10, m00)
  const m10 = t.m10 ?? 0;
  const angle = Math.round(Math.atan2(m10, m00) * 180 / Math.PI);
  return angle;
}

// ─── Build styles ───
function buildStyles(nc, parentNc) {
  const styles = {};
  const classes = [];
  const size = nc.size || {};

  // Visibility
  if (nc.visible === false) return { skip: true };

  // Opacity
  if (nc.opacity !== undefined && nc.opacity !== 1) {
    styles.opacity = nc.opacity.toFixed(2);
  }

  // Size
  if (size.x) styles.width = `${Math.round(size.x)}px`;
  // Auto-layout vertical containers grow with content, UNLESS they have a background-image
  // (which needs explicit height to be visible)
  const hasImgFillOnNode = (nc.fillPaints || []).some(f => f.visible !== false && f.type === 'IMAGE');
  if (size.y && (!(isAutoLayout(nc) && nc.stackMode === 'VERTICAL') || hasImgFillOnNode)) {
    styles.height = `${Math.round(size.y)}px`;
  }

  // Rotation
  const rotation = getRotation(nc);
  if (rotation !== 0) {
    styles.transform = `rotate(${rotation}deg)`;
  }

  // Position: absolute if parent is not auto-layout or child is positioned absolutely
  const isRootChild = parentNc && !parentNc._hasParent;

  // Fixed-position elements: header and player
  const name = nc.name || '';
  if (isRootChild && (name.includes('Header') || name.includes('header'))) {
    classes.push('fixed');
    styles.top = '0';
    styles.left = '0';
    styles.right = '0';
    styles['z-index'] = '50';
    delete styles.width;
  } else if (isRootChild && (name.includes('Lecteur') || name.includes('Player'))) {
    classes.push('fixed');
    styles.bottom = '0';
    styles.left = '0';
    styles.right = '0';
    styles['z-index'] = '50';
    delete styles.width;
  } else if (parentNc && isAbsoluteChild(nc, parentNc, isRootChild)) {
    classes.push('absolute');
    const pos = getPosition(nc);
    if (pos.x !== 0) styles.left = `${Math.round(pos.x)}px`;
    if (pos.y !== 0) styles.top = `${Math.round(pos.y)}px`;
  }

  // Auto-layout (flex)
  if (isAutoLayout(nc)) {
    classes.push('flex');
    if (nc.stackMode === 'VERTICAL') classes.push('flex-col');

    if (nc.stackSpacing) styles.gap = `${Math.round(nc.stackSpacing)}px`;

    // Padding
    const pt = nc.stackVerticalPadding ?? nc.stackPadding ?? 0;
    const pb = nc.stackPaddingBottom ?? pt;
    const pl = nc.stackHorizontalPadding ?? nc.stackPadding ?? 0;
    const pr = nc.stackPaddingRight ?? pl;
    if (pt || pb || pl || pr) {
      styles.padding = `${Math.round(pt)}px ${Math.round(pr)}px ${Math.round(pb)}px ${Math.round(pl)}px`;
    }

    // Alignment
    const align = nc.stackCounterAlign || nc.stackAlign;
    if (align === 'CENTER') classes.push('items-center');
    else if (align === 'MAX') classes.push('items-end');

    const justify = nc.stackJustify || nc.stackPrimaryAlignItems;
    if (justify === 'SPACE_BETWEEN') classes.push('justify-between');
    else if (justify === 'CENTER') classes.push('justify-center');
    else if (justify === 'MAX') classes.push('justify-end');

    // Sizing
    if (nc.stackPrimarySizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE') {
      // width/height auto
      delete styles.width;
    }
  }

  // Corner radius
  if (nc.cornerRadius) {
    styles['border-radius'] = `${Math.round(nc.cornerRadius)}px`;
  }

  // Background
  const fills = (nc.fillPaints || []).filter(f => f.visible !== false);
  const solidFills = fills.filter(f => f.type === 'SOLID');
  const gradientFills = fills.filter(f => f.type === 'GRADIENT_LINEAR');
  const imageFills = fills.filter(f => f.type === 'IMAGE');

  // Skip background for VECTOR/BOOLEAN_OPERATION — their fills are in SVG paths
  if (nc.type !== 'VECTOR' && nc.type !== 'BOOLEAN_OPERATION') {
    if (imageFills.length > 0) {
      // Image background — handled separately
    } else if (gradientFills.length > 0) {
      const grad = gradientToCSS(gradientFills[0]);
      if (grad) styles.background = grad;
    } else if (solidFills.length > 0) {
      const fill = solidFills[0];
      styles.background = colorToCSS(fill.color, fill.opacity ?? 1);
    }
  }

  // Border (stroke) — skip for VECTOR nodes (stroke is in the SVG path)
  const allStrokes = (nc.strokePaints || []).filter(f => f.visible !== false);
  const solidStrokes = allStrokes.filter(f => f.type === 'SOLID');
  const gradientStrokes = allStrokes.filter(f => f.type === 'GRADIENT_LINEAR');
  const sw = nc.strokeWeight;
  if (sw && nc.type !== 'VECTOR') {
    if (solidStrokes.length > 0) {
      const sc = colorToCSS(solidStrokes[0].color, solidStrokes[0].opacity ?? 1);
      styles.border = `${sw}px solid ${sc}`;
    } else if (gradientStrokes.length > 0) {
      // CSS can't do gradient borders directly — approximate with the first stop color
      const gs = gradientStrokes[0];
      const stops = gs.stops || gs.colorStops || [];
      const opacity = gs.opacity ?? 1;
      if (stops.length > 0) {
        const avgColor = colorToCSS(stops[0].color, opacity * (stops[0].color?.a ?? 1));
        styles.border = `${sw}px solid ${avgColor}`;
      }
    }
  }

  // Effects
  for (const eff of nc.effects || []) {
    if (eff.visible === false) continue;
    if (eff.type === 'BACKGROUND_BLUR' && eff.radius) {
      styles['backdrop-filter'] = `blur(${eff.radius}px)`;
    }
    if (eff.type === 'LAYER_BLUR' && eff.radius) {
      styles.filter = `blur(${eff.radius}px)`;
    }
    if (eff.type === 'DROP_SHADOW') {
      const c = colorToCSS(eff.color, eff.color?.a ?? 0.25);
      styles['box-shadow'] = `${eff.offset?.x || 0}px ${eff.offset?.y || 4}px ${eff.radius || 8}px ${c}`;
    }
  }

  // Typography (TEXT nodes)
  if (nc.type === 'TEXT') {
    const fn = nc.fontName;
    if (fn?.family) styles['font-family'] = `'${fn.family}', sans-serif`;
    if (fn?.style?.includes('Bold') || fn?.style?.includes('SemiBold')) styles['font-weight'] = fn.style.includes('Semi') ? '600' : '700';
    else if (fn?.style?.includes('Medium')) styles['font-weight'] = '500';
    else if (fn?.style?.includes('Light')) styles['font-weight'] = '300';

    if (nc.fontSize) styles['font-size'] = `${nc.fontSize}px`;

    const lh = nc.lineHeight;
    if (lh?.units === 'PIXELS' && lh.value) styles['line-height'] = `${lh.value}px`;
    else if (lh?.units === 'PERCENT' && lh.value) styles['line-height'] = `${(lh.value / 100).toFixed(2)}`;

    const ls = nc.letterSpacing;
    if (ls?.units === 'PERCENT' && ls.value) styles['letter-spacing'] = `${(ls.value / 100).toFixed(3)}em`;
    else if (ls?.units === 'PIXELS' && ls.value) styles['letter-spacing'] = `${ls.value}px`;

    if (nc.textCase === 'UPPER') styles['text-transform'] = 'uppercase';
    if (nc.textCase === 'LOWER') styles['text-transform'] = 'lowercase';

    // Text color from fills
    if (solidFills.length > 0) {
      styles.color = colorToCSS(solidFills[0].color, solidFills[0].opacity ?? 1);
      delete styles.background;
    }
  }

  return { styles, classes, skip: false };
}

// ─── HTML generation ───
function styleStr(styles) {
  return Object.entries(styles).map(([k, v]) => `${k}:${v}`).join(';');
}

function dataAttrs(nodeId, nc) {
  const name = (nc.name || '').replace(/"/g, '&quot;');
  return `data-nid="${nodeId}" data-figma="${name}"`;
}

// Convert Figma node name to a valid custom element tag
// Custom elements must contain a hyphen and only lowercase alphanum + hyphens
function figmaTag(nc) {
  const name = nc.name || '';
  // Slugify: lowercase, replace non-alphanum with hyphens, collapse
  let tag = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Must contain a hyphen to be a valid custom element
  if (!tag.includes('-')) tag = 'x-' + tag;
  // Must start with a letter
  if (!/^[a-z]/.test(tag)) tag = 'x-' + tag;
  return tag || 'x-node';
}

function generateNode(nid, parentNc, depth, maxDepth, indent = 0, instanceCtx = null, siblingNids = null) {
  if (depth > maxDepth) return '';
  let nc = nodesById.get(nid);
  if (!nc) return '';
  nc._hasParent = !!parentNc;

  // Apply instance overrides via overrideKey mapping
  if (instanceCtx) {
    // 1. symbolOverrides (via overrideKey)
    const ovs = overrideMap[instanceCtx];
    if (ovs) {
      const okey = nidToOkey[nid];
      if (okey && ovs[okey]) {
        const ov = ovs[okey];
        if (ov.textCharacters !== undefined && nc.textData) {
          nc = { ...nc, textData: { ...nc.textData, characters: ov.textCharacters } };
        }
        if (ov.visible !== undefined) {
          nc = { ...nc, visible: ov.visible };
        }
      }
    }

    // 2. componentPropAssignments (TEXT props via defID)
    const assigns = propAssignments[instanceCtx];
    if (assigns) {
      const propDefId = nidToPropDef[nid];
      if (propDefId && assigns[propDefId]?.type === 'TEXT') {
        nc = { ...nc, textData: { ...(nc.textData || {}), characters: assigns[propDefId].text } };
      }
    }
  }

  const { styles, classes, skip } = buildStyles(nc, parentNc);
  if (skip) return '';

  // Skip design mockup elements
  const skipNames = ['Core / Google Chrome', 'tabs-bar', 'toolbar', 'AI button', 'Background Shape'];
  if (skipNames.some(s => (nc.name || '').startsWith(s))) return '';

  // Skip decorative Background component (oversized, purely visual)
  if (nc.name === 'Background' && nc.type === 'INSTANCE') return '';

  // Skip elements wider than the page (decorative overflow images)
  const nodeW = nc.size?.x || 0;
  const nodeH = nc.size?.y || 0;
  if (parentNc && nodeW > (parentNc.size?.x || 9999) * 1.2 && nodeH > 1000) return '';

  const pad = '  '.repeat(indent);
  const g = nc.guid || {};
  const nodeId = `${g.sessionID || 0}:${g.localID || 0}`;
  let children = getChildren(nid);
  const imageFills = (nc.fillPaints || []).filter(f => f.visible !== false && f.type === 'IMAGE');
  const hasImageFill = imageFills.length > 0;

  // Resolve INSTANCE nodes: if no children, use the source SYMBOL's children
  let childInstanceCtx = instanceCtx;
  if (nc.type === 'INSTANCE' && children.length === 0 && nc.symbolData?.symbolID) {
    let sid = nc.symbolData.symbolID;
    let sourceNid = `${sid.sessionID}:${sid.localID}`;

    // Check if a parent instance has a prop swap for this child instance
    if (instanceCtx) {
      const assigns = propAssignments[instanceCtx];
      if (assigns) {
        for (const [defId, assign] of Object.entries(assigns)) {
          if (assign.type !== 'INSTANCE_SWAP') continue;
          const swapNode = nodesById.get(assign.targetNid);
          if (!swapNode) continue;
          // Match: the swap target's name prefix matches our current source's name prefix
          const sourceName = nodesById.get(sourceNid)?.name || '';
          const swapName = swapNode.name || '';
          const sourcePrefix = sourceName.split('/')[0];
          if (sourcePrefix && swapName.startsWith(sourcePrefix)) {
            sourceNid = assign.targetNid;
            children = getChildren(sourceNid);
            break;
          }
        }
      }
    }

    if (children.length === 0) children = getChildren(sourceNid);

    // If source SYMBOL has an image fill, apply it to this instance container
    const sourceNc = nodesById.get(sourceNid);
    const sourceImgFills = (sourceNc?.fillPaints || []).filter(f => f.visible !== false && f.type === 'IMAGE');
    if (sourceImgFills.length > 0) {
      const imgUrl = getImageUrl(sourceNc);
      if (imgUrl) {
        if (children.length === 0) {
          // Leaf: render as <img>
          const sSize = sourceNc.size || {};
          classes.push('overflow-hidden');
          if (sSize.x) styles.width = `${Math.round(sSize.x)}px`;
          if (sSize.y) styles.height = `${Math.round(sSize.y)}px`;
          const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
          const sty = Object.keys(styles).length ? ` style="${styleStr(styles)}"` : '';
          { const t = figmaTag(nc); return `${pad}<${t}${cls}${sty} ${dataAttrs(nodeId, nc)}><img src="${imgUrl}" alt="${sourceNc.name || ''}" class="w-full h-full object-cover"></${t}>\n`; }
        } else {
          // Has children: use as background-image
          styles['background-image'] = `url('${imgUrl}')`;
          styles['background-size'] = 'cover';
          styles['background-position'] = 'center';
          // Ensure height is set (background-image needs explicit height)
          const sSize = sourceNc.size || {};
          if (sSize.y && !styles.height) styles.height = `${Math.round(sSize.y)}px`;
        }
      }
    }

    // This instance becomes the context for override/prop lookups on its children
    if (overrideMap[nodeId] || propAssignments[nodeId]) {
      childInstanceCtx = nodeId;
    }

    // Check if parent instance has nested prop assignments for this instance
    // (e.g. TRACKS overriding Card Infos genre text via symbolOverrides)
    if (instanceCtx && nc.type === 'INSTANCE') {
      const parentOvs = overrideMap[instanceCtx];
      if (parentOvs) {
        const okey = nidToOkey[nid];
        if (okey && parentOvs[okey]?.nestedPropAssignments) {
          // Create a synthetic prop assignment entry for this instance
          const nested = parentOvs[okey].nestedPropAssignments;
          // Merge with existing prop assignments (nested overrides take precedence)
          const merged = { ...(propAssignments[nodeId] || {}), ...nested };
          propAssignments[nodeId] = merged;
          childInstanceCtx = nodeId;
        }
      }
    }
  }

  // TEXT node
  if (nc.type === 'TEXT') {
    const text = nc.textData?.characters || '';
    if (!text) return '';
    // Multi-line: replace \n with <br>
    const htmlText = text.replace(/\n/g, '<br>');
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const sty = Object.keys(styles).length ? ` style="${styleStr(styles)}"` : '';
    return `${pad}<span${cls}${sty} ${dataAttrs(nodeId, nc)}>${htmlText}</span>\n`;
  }

  // VECTOR node — render as inline SVG
  if (nc.type === 'VECTOR') {
    const svg = getSvgContent(nodeId);
    if (svg) {
      const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
      const sty = Object.keys(styles).length ? ` style="${styleStr(styles)}"` : '';
      // Wrap SVG in a container with position
      { const t = figmaTag(nc); return `${pad}<${t}${cls}${sty} ${dataAttrs(nodeId, nc)}>${svg}</${t}>\n`; }
    }
    return '';
  }

  // Image fill — render as <img> (or background-image if also has color overlay)
  if (hasImageFill && children.length === 0) {
    const imgUrl = getImageUrl(nc);
    if (imgUrl) {
      if (!isAutoLayout(nc)) classes.push('overflow-hidden');
      // Check for color overlay (solid fill on top of image)
      const sfn = (nc.fillPaints || []).filter(f => f.visible !== false && f.type === 'SOLID');
      const overlay = sfn.length > 0 ? colorToCSS(sfn[0].color, sfn[0].opacity ?? 1) : null;
      const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
      const sty = Object.keys(styles).length ? ` style="${styleStr(styles)}"` : '';
      let inner = `<img src="${imgUrl}" alt="${nc.name || ''}" class="w-full h-full object-cover">`;
      if (overlay) inner += `<div class="absolute inset-0" style="background:${overlay}"></div>`;
      { const t = figmaTag(nc); return `${pad}<${t}${cls}${sty} ${dataAttrs(nodeId, nc)}>${inner}</${t}>\n`; }
    }
  }

  // Container (FRAME, INSTANCE, SYMBOL, etc.)
  // If it has an image fill AND children, use background-image
  if (hasImageFill) {
    const imgUrl = getImageUrl(nc);
    if (imgUrl) {
      styles['background-image'] = `url('${imgUrl}')`;
      styles['background-size'] = 'cover';
      styles['background-position'] = 'center';
    }
  }

  // If both image and solid fill exist on a container, add an overlay child
  let overlayHtml = '';
  const solidFillsNode = (nc.fillPaints || []).filter(f => f.visible !== false && f.type === 'SOLID');
  if (hasImageFill && solidFillsNode.length > 0) {
    const overlay = colorToCSS(solidFillsNode[0].color, solidFillsNode[0].opacity ?? 1);
    if (overlay) overlayHtml = `${pad}  <div class="absolute inset-0" style="background:${overlay}"></div>\n`;
  }

  // Root-level container
  if (!parentNc) {
    styles['overflow-x'] = 'hidden';
    styles['padding-top'] = '70px';
    styles['padding-bottom'] = '80px';
    delete styles.height;
  }

  // Need relative if any child is absolute
  const hasAbsoluteChildren = children.some(cid => {
    const childNc = nodesById.get(cid);
    return childNc && isAbsoluteChild(childNc, nc);
  });
  if (hasAbsoluteChildren) classes.push('relative');

  // Overflow hidden if has corner radius
  if (nc.cornerRadius) classes.push('overflow-hidden');
  // Clip frames that have clipping enabled (frameMaskDisabled !== true)
  // and fixed height with children that might overflow
  if (nc.type === 'FRAME' && nc.frameMaskDisabled !== true && styles.height) {
    styles.overflow = 'hidden';
  }

  const tag = figmaTag(nc);
  // Custom elements are inline by default — ensure block display if not flex
  if (!classes.includes('flex') && !classes.includes('flex-col') && !styles.display) {
    styles.display = 'block';
  }
  const cls2 = classes.length ? ` class="${classes.join(' ')}"` : '';
  const sty2 = Object.keys(styles).length ? ` style="${styleStr(styles)}"` : '';

  let html = `${pad}<${tag}${cls2}${sty2} ${dataAttrs(nodeId, nc)}>\n`;
  html += overlayHtml;

  // Component set detection: if all children are SYMBOLs (variants),
  // only render the first one (default state)
  const allSymbols = children.length > 1 && children.every(cid => nodesById.get(cid)?.type === 'SYMBOL');
  const renderChildren = allSymbols ? children.slice(0, 1) : children;

  for (const cid of renderChildren) {
    html += generateNode(cid, nc, depth + 1, maxDepth, indent + 1, childInstanceCtx, null);
  }

  html += `${pad}</${tag}>\n`;
  return html;
}

// ─── CLI ───
const args = process.argv.slice(2);
const nodeId = args[0];
if (!nodeId) {
  console.error('Usage: figma-kiwi to-html <node_id> [--depth N] [--out file.html]');
  console.error('  figma-kiwi to-html 551:7055    # carousel default state');
  console.error('  figma-kiwi to-html 80:1821     # full home page');
  process.exit(1);
}

let maxDepth = 10;
let outFile = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--depth' && args[i + 1]) maxDepth = parseInt(args[i + 1]);
  if (args[i] === '--out' && args[i + 1]) outFile = args[i + 1];
}

const nc = nodesById.get(nodeId);
if (!nc) {
  console.error(`Node ${nodeId} not found`);
  process.exit(1);
}

console.error(`Generating HTML for: ${nc.name} (${nodeId}) [${nc.type}]`);
console.error(`Max depth: ${maxDepth}`);

const body = generateNode(nodeId, null, 0, maxDepth);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${nc.name || nodeId}</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'DM Sans', sans-serif; margin: 0; background: #121212; overflow-x: hidden; }
    [data-nid] img { display: block; }
  </style>
</head>
<body>
${body}
</body>
</html>`;

if (outFile) {
  writeFileSync(outFile, html);
  console.error(`Written to ${outFile}`);
} else {
  console.log(html);
}
