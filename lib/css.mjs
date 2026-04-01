// Extract CSS-like properties from Figma scenegraph nodes.
// Works with both REST API node format and decoded Kiwi node format.
//
// Pure functions — no I/O, no side effects.

/**
 * Convert Figma RGBA {r, g, b, a} (0-1 floats) to CSS color string.
 */
export function rgbaToCSS(c, opacity) {
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  const a = opacity !== undefined ? opacity : (c.a ?? 1);
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Extract CSS properties from a decoded Kiwi scenegraph node (raw nodeChange).
 *
 * @param {object} raw - Raw nodeChange from decoded scenegraph
 * @returns {object} CSS property map
 */
export function extractCSSFromKiwi(raw) {
  const css = {};

  // Dimensions
  const size = raw.size;
  if (size) {
    css.width = `${size.x || 0}px`;
    css.height = `${size.y || 0}px`;
  }

  // Flex layout (stackMode)
  const sm = raw.stackMode;
  if (sm && sm !== 'NONE') {
    css.display = 'flex';
    css['flex-direction'] = sm === 'VERTICAL' ? 'column' : 'row';
  }

  const spacing = raw.stackSpacing;
  if (spacing != null) css.gap = `${spacing}px`;

  // Padding
  const pt = raw.stackVerticalPadding ?? raw.stackPadding ?? 0;
  const pl = raw.stackHorizontalPadding ?? raw.stackPadding ?? 0;
  const pb = raw.stackPaddingBottom ?? pt;
  const pr = raw.stackPaddingRight ?? pl;
  if (pt || pl || pb || pr) {
    css.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
  }

  // Corner radius
  if (raw.cornerRadius) css['border-radius'] = `${raw.cornerRadius}px`;

  // Opacity
  if (raw.opacity != null && raw.opacity !== 1) css.opacity = raw.opacity.toFixed(2);

  // Background (fill paints)
  for (const fill of raw.fillPaints || []) {
    if (fill.type === 'SOLID' && fill.visible !== false) {
      const c = fill.color || {};
      const alpha = (c.a ?? 1) * (fill.opacity ?? 1);
      if (alpha < 1) {
        css.background = `rgba(${Math.round((c.r||0)*255)}, ${Math.round((c.g||0)*255)}, ${Math.round((c.b||0)*255)}, ${alpha.toFixed(2)})`;
      } else {
        const r = Math.round((c.r||0)*255), g = Math.round((c.g||0)*255), b = Math.round((c.b||0)*255);
        css.background = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
      }
    }
  }

  // Typography
  const td = raw.textData;
  if (td?.characters) css.text = td.characters.slice(0, 200);

  const fn = raw.fontName;
  if (fn) {
    css['font-family'] = fn.family || '';
    css['font-style'] = fn.style || '';
  }
  if (raw.fontSize) css['font-size'] = `${raw.fontSize}px`;

  const lh = raw.lineHeight;
  if (lh?.value) css['line-height'] = `${lh.value}px`;

  const ls = raw.letterSpacing;
  if (ls?.value) {
    css['letter-spacing'] = ls.units === 'PERCENT' ? `${ls.value.toFixed(1)}%` : `${ls.value.toFixed(2)}px`;
  }

  const ta = raw.textAlignHorizontal;
  if (ta && ta !== 'LEFT') css['text-align'] = ta.toLowerCase();

  // Stroke / border
  const strokes = raw.strokePaints || [];
  const sw = raw.strokeWeight;
  if (sw && strokes.length > 0) {
    const c = strokes[0].color || {};
    const r = Math.round((c.r||0)*255), g = Math.round((c.g||0)*255), b = Math.round((c.b||0)*255);
    css.border = `${sw}px solid #${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  return css;
}

/**
 * Extract CSS from a Figma REST API node object.
 *
 * @param {object} node - Node from Figma REST API response
 * @returns {object} CSS property map
 */
export function extractCSSFromAPI(node) {
  const css = {};

  // Dimensions
  const bb = node.absoluteBoundingBox;
  if (bb) {
    css.width = `${bb.width || 0}px`;
    css.height = `${bb.height || 0}px`;
  }

  // Border radius
  if (node.cornerRadius > 0) {
    css['border-radius'] = `${node.cornerRadius}px`;
  } else if (node.rectangleCornerRadii) {
    css['border-radius'] = node.rectangleCornerRadii.map(r => `${r}px`).join(' ');
  }

  // Opacity
  if (node.opacity != null && node.opacity < 1) css.opacity = node.opacity.toFixed(2);

  // Auto-layout
  if (node.layoutMode) {
    css.display = 'flex';
    css['flex-direction'] = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    if (node.itemSpacing > 0) css.gap = `${node.itemSpacing}px`;

    const pt = node.paddingTop || 0, pr = node.paddingRight || 0;
    const pb = node.paddingBottom || 0, pl = node.paddingLeft || 0;
    if (pt || pr || pb || pl) css.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;

    const alignMap = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
    if (node.primaryAxisAlignItems in alignMap) css['justify-content'] = alignMap[node.primaryAxisAlignItems];
    if (node.counterAxisAlignItems in alignMap) css['align-items'] = alignMap[node.counterAxisAlignItems];
  }

  // Fills -> background
  for (const fill of node.fills || []) {
    if (fill.visible === false) continue;
    if (fill.type === 'SOLID') {
      css.background = rgbaToCSS(fill.color, fill.opacity);
    } else if (fill.type?.includes('GRADIENT')) {
      const stops = (fill.gradientStops || []).map(s => {
        const color = rgbaToCSS(s.color);
        const pos = s.position != null ? ` ${(s.position * 100).toFixed(0)}%` : '';
        return `${color}${pos}`;
      });
      css.background = fill.type.includes('RADIAL')
        ? `radial-gradient(${stops.join(', ')})`
        : `linear-gradient(${stops.join(', ')})`;
    } else if (fill.type === 'IMAGE') {
      css.background = `url(<image:${fill.imageRef || '?'}>)`;
    }
  }

  // Strokes -> border
  for (const s of node.strokes || []) {
    if (s.visible === false) continue;
    if (s.type === 'SOLID') {
      css.border = `${node.strokeWeight || 1}px solid ${rgbaToCSS(s.color, s.opacity)}`;
    }
  }

  // Effects
  const shadows = [];
  for (const e of node.effects || []) {
    if (!e.visible) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const o = e.offset || {};
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      shadows.push(`${inset}${o.x||0}px ${o.y||0}px ${e.radius||0}px ${e.spread||0}px ${rgbaToCSS(e.color || {})}`);
    } else if (e.type === 'LAYER_BLUR') {
      css.filter = `blur(${e.radius || 0}px)`;
    } else if (e.type === 'BACKGROUND_BLUR') {
      css['backdrop-filter'] = `blur(${e.radius || 0}px)`;
    }
  }
  if (shadows.length) css['box-shadow'] = shadows.join(', ');

  // Typography
  const style = node.style || {};
  if (style.fontFamily) css['font-family'] = style.fontFamily;
  if (style.fontSize) css['font-size'] = `${style.fontSize}px`;
  if (style.fontWeight) css['font-weight'] = String(Math.round(style.fontWeight));
  if (style.lineHeightPx) css['line-height'] = `${style.lineHeightPx.toFixed(1)}px`;
  if (style.letterSpacing) css['letter-spacing'] = `${style.letterSpacing.toFixed(2)}px`;

  // Text color (from fills on TEXT nodes)
  if (node.type === 'TEXT') {
    for (const f of node.fills || []) {
      if (f.type === 'SOLID' && f.visible !== false) {
        css.color = rgbaToCSS(f.color, f.opacity);
        delete css.background;
        break;
      }
    }
  }

  return css;
}
