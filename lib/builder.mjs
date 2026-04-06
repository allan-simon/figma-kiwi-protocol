// FigmaBuilder — minimal helper to build a tree of Figma nodes from scratch.
//
// Tracks a per-session localID counter, fills in the boring required fields
// (transform, opacity, visible, stroke defaults, fillPaints), and emits a flat
// list of nodeChanges ready to feed FigmaSession.mutate().
//
// Each node factory returns an opaque "ref" object you pass as the parent of
// children. The ref carries the assigned guid so children can be linked back.
//
// Designed for FRAME nodes today. SYMBOL needs more bookkeeping (component keys,
// publishing metadata) and is intentionally out of scope.

const IDENTITY_TRANSFORM = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 0, m12: 0 };

function defaultFill(rgba) {
  return [{
    type: 'SOLID',
    color: { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] ?? 1 },
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
  }];
}

export class FigmaBuilder {
  constructor({ sessionID, localIDStart = 1 }) {
    this.sessionID = sessionID;
    this.nextLocal = localIDStart;
    this.changes = [];
    // Per-parent child counter so each new sibling gets a strictly-increasing
    // parentIndex.position. Same-position siblings are sorted arbitrarily by
    // Figma (probably by guid), which silently inverts visual order.
    this.childCountByParent = new Map();
  }

  /** Generate a strictly-increasing position string for the Nth child of a parent. */
  _nextPosition(parentKey) {
    const idx = (this.childCountByParent.get(parentKey) || 0);
    this.childCountByParent.set(parentKey, idx + 1);
    // Single-letter base-26 — fine for any sane sibling count and lexicographic
    // sort gives the correct order. "a", "b", … "z", "aa", "ab", …
    let s = '';
    let n = idx;
    do {
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  }

  /** Build a top-level frame node attached to the given parent guid. */
  frame({ name, parent, size, fill, ...overrides } = {}) {
    return this._node('FRAME', { name, parent, size, fill, ...overrides });
  }

  /** Build a rounded rectangle (a leaf shape, no children). Useful as a coloured placeholder. */
  rect({ name, parent, size, fill, cornerRadius = 0, ...overrides } = {}) {
    return this._node('ROUNDED_RECTANGLE', { name, parent, size, fill, cornerRadius, ...overrides });
  }

  _node(type, { name, parent, size, fill, cornerRadius, ...overrides }) {
    const guid = { sessionID: this.sessionID, localID: this.nextLocal++ };
    const change = {
      guid,
      phase: 'CREATED',
      type,
      name: name ?? `New ${type}`,
      visible: true,
      opacity: 1,
      size: size ?? { x: 100, y: 100 },
      transform: { ...IDENTITY_TRANSFORM, m11: 1 },
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      fillPaints: fill ? defaultFill(fill) : defaultFill([1, 1, 1, 0]),
    };
    if (cornerRadius != null) change.cornerRadius = cornerRadius;
    if (parent) {
      const parentGuid = parent.guid || parent;
      const parentKey = `${parentGuid.sessionID}:${parentGuid.localID}`;
      change.parentIndex = {
        guid: parentGuid,
        // Caller can force a position; otherwise auto-increment per parent.
        position: parent.position || this._nextPosition(parentKey),
      };
    }
    // Anything else the caller passed (stack* fields, etc) wins.
    Object.assign(change, overrides);
    // Wire format gotcha: minSize / maxSize are an OptionalVector struct,
    // i.e. {value: {x, y}} not {x, y}. Auto-wrap whatever the caller gave us
    // — but do it AFTER the Object.assign so we override the unwrapped form.
    for (const k of ['minSize', 'maxSize']) {
      if (change[k] && !('value' in change[k])) {
        change[k] = { value: change[k] };
      }
    }
    this.changes.push(change);
    return { guid, ref: change };
  }

  /** All accumulated nodeChanges, in creation order. */
  build() {
    return this.changes;
  }
}
