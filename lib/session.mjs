// FigmaSession — persistent multiplayer connection with a high-level mutation API.
//
// Holds a single WebSocket open, tracks sessionID/ackID, and resolves each
// mutate() call when the server echoes back the matching ackID. Built on top
// of the wire-protocol findings documented in lat.md/wire-protocol.md.
//
// Usage:
//   import { FigmaSession } from 'figma-kiwi-protocol/session';
//   const session = await FigmaSession.connect({ handshakePath: '/tmp/figma_handshake.json' });
//   await session.rename({ sessionID: 2004, localID: 16177 }, 'New Name');
//   await session.setStackMode({ sessionID: 2010, localID: 16169 }, 'HORIZONTAL');
//   await session.close();

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const WebSocket = require('/tmp/node_modules/ws');

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZstd(u8) {
  return u8.length >= 4 && u8[0] === ZSTD_MAGIC[0] && u8[1] === ZSTD_MAGIC[1] && u8[2] === ZSTD_MAGIC[2] && u8[3] === ZSTD_MAGIC[3];
}

function isFigWire(u8) {
  // Magic header 'fig' (0x66 0x69 0x67) at offset 0 — same check used by lib/kiwi.mjs
  return u8.length > 8 && u8[0] === 0x66 && u8[1] === 0x69 && u8[2] === 0x67;
}

export class FigmaSession {
  constructor({ Schema, ws, multiplayerUrl }) {
    this.Schema = Schema;
    this.ws = ws;
    this.multiplayerUrl = multiplayerUrl;
    this.sessionID = null;            // assigned by server in JOIN_START
    this.lastSeenAckID = 0;           // last ackID we observed from any source
    this.ackIncrement = 25;           // gap to leave between consecutive client mutations
    this.pendingAcks = new Map();     // ackID → { resolve, reject, timer }
    this.fullSyncReceived = false;
    this._fullSyncWaiters = [];
    this._closed = false;
  }

  static async connect({
    handshakePath = '/tmp/figma_handshake.json',
    kiwiDir = '/tmp/figma_full_sync',
    timeoutMs = 30000,
  } = {}) {
    const hs = JSON.parse(readFileSync(handshakePath, 'utf8'));
    const Schema = require(`${kiwiDir}/figma_decoder.js`);

    const mp = hs.sockets.find(s => /\/api\/multiplayer\//.test(s.url));
    if (!mp) throw new Error(`No multiplayer URL in ${handshakePath}`);

    // Rotate tracking_session_id without re-serializing the URL — see
    // lat.md/standalone-client.md "URL serialization gotcha".
    const newTSID = randomBytes(8).toString('base64url').slice(0, 16);
    const wsUrl = mp.url.replace(/tracking_session_id=[^&]+/, `tracking_session_id=${newTSID}`);

    const cookieHeader = hs.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const headers = {
      Origin: 'https://www.figma.com',
      'User-Agent': mp.requestHeaders?.['User-Agent'] || mp.requestHeaders?.['user-agent'] || 'Mozilla/5.0',
      Cookie: cookieHeader,
    };

    const ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false });
    const session = new FigmaSession({ Schema, ws, multiplayerUrl: wsUrl });
    session._wireUp();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`FigmaSession.connect timed out after ${timeoutMs}ms before full sync`)), timeoutMs);
      session._fullSyncWaiters.push(() => { clearTimeout(timer); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });

    return session;
  }

  _wireUp() {
    const debug = !!process.env.FIGMA_KIWI_DEBUG;
    this.ws.on('open', () => { if (debug) console.error('[session] ws open'); });
    this.ws.on('message', (data, isBinary) => {
      if (debug) console.error(`[session] msg binary=${isBinary} len=${data.length}`);
      if (!isBinary) return;
      const u8 = new Uint8Array(data);
      if (isFigWire(u8)) return;       // skip schema frame
      const decompressed = isZstd(u8) ? new Uint8Array(zstdDecompressSync(data)) : u8;
      let m;
      try { m = this.Schema.decodeMessage(decompressed); } catch (e) {
        if (debug) console.error(`[session] decode err: ${e.message}`);
        return;
      }
      if (debug) console.error(`[session] decoded type=${m.type} sessionID=${m.sessionID ?? '-'} ackID=${m.ackID ?? '-'} nodeChanges=${m.nodeChanges?.length ?? 0}`);
      this._handleMessage(m);
    });
    this.ws.on('close', (code, reason) => {
      this._closed = true;
      // Reject any in-flight mutations
      for (const [, p] of this.pendingAcks) {
        clearTimeout(p.timer);
        p.reject(new Error(`WebSocket closed (code=${code}) before ack`));
      }
      this.pendingAcks.clear();
    });
  }

  _handleMessage(m) {
    if (m.sessionID != null) this.sessionID = m.sessionID;
    if (m.ackID != null && m.ackID > this.lastSeenAckID) this.lastSeenAckID = m.ackID;

    // Server ack for one of our pending mutations?
    if (m.type === 'NODE_CHANGES' && m.ackID != null && this.pendingAcks.has(m.ackID)) {
      const p = this.pendingAcks.get(m.ackID);
      this.pendingAcks.delete(m.ackID);
      clearTimeout(p.timer);
      p.resolve({ ackID: m.ackID, nodeChanges: m.nodeChanges });
    }

    // Initial full sync — large NODE_CHANGES with many entries marks "ready to write"
    if (!this.fullSyncReceived && m.type === 'NODE_CHANGES' && (m.nodeChanges?.length || 0) > 100) {
      this.fullSyncReceived = true;
      for (const w of this._fullSyncWaiters) w();
      this._fullSyncWaiters.length = 0;
    }
  }

  // --- low-level mutation ---

  /**
   * Send a NODE_CHANGES message and resolve when the server echoes back our ackID.
   * Each call advances ackID by ackIncrement (default 25).
   *
   * @param {Array<Object>} nodeChanges  — array of partial node patches keyed by guid
   * @param {{ timeoutMs?: number }} opts
   * @returns {Promise<{ackID:number, nodeChanges:any[]}>}
   */
  async mutate(nodeChanges, { timeoutMs = 10000 } = {}) {
    if (this._closed) throw new Error('FigmaSession is closed');
    if (this.sessionID == null) throw new Error('Not joined yet (no sessionID from server)');

    const ackID = this.lastSeenAckID + this.ackIncrement;
    this.lastSeenAckID = ackID;

    const message = {
      type: 'NODE_CHANGES',
      sessionID: this.sessionID,
      ackID,
      sentTimestamp: BigInt(Date.now()),
      nodeChanges,
    };

    const encoded = this.Schema.encodeMessage(message);
    const compressed = zstdCompressSync(Buffer.from(encoded));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(ackID);
        reject(new Error(`Mutation ackID=${ackID} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingAcks.set(ackID, { resolve, reject, timer });
      this.ws.send(compressed, { binary: true }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingAcks.delete(ackID);
          reject(err);
        }
      });
    });
  }

  // --- high-level helpers ---
  // Each one builds the smallest sufficient nodeChanges entry and delegates to mutate().
  // Uses the field names as they appear on the wire (NOT the plugin API names) — see
  // lat.md/auto-layout.md for the mapping.

  /** Rename a layer. */
  async rename(guid, name) {
    return this.mutate([{ guid: this._guid(guid), name }]);
  }

  /**
   * Set auto-layout direction (or disable). One of: VERTICAL | HORIZONTAL | GRID | NONE.
   * NONE disables auto-layout entirely.
   */
  async setStackMode(guid, mode) {
    if (!['VERTICAL', 'HORIZONTAL', 'GRID', 'NONE'].includes(mode)) {
      throw new Error(`setStackMode: invalid mode "${mode}"`);
    }
    return this.mutate([{ guid: this._guid(guid), stackMode: mode }]);
  }

  /**
   * Enable auto-layout from scratch with sensible defaults.
   * Mirrors what Shift+A does in the UI: VERTICAL, 10px padding on every side, 10px spacing,
   * counter axis hugs contents.
   */
  async enableAutoLayout(guid, {
    direction = 'VERTICAL',
    spacing = 10,
    paddingLeft = 10,
    paddingRight = 10,
    paddingTop = 10,
    paddingBottom = 10,
    hug = 'counter', // 'both' | 'primary' | 'counter' | 'none'
  } = {}) {
    const change = {
      guid: this._guid(guid),
      stackMode: direction,
      stackSpacing: spacing,
      stackHorizontalPadding: paddingLeft,
      stackPaddingRight: paddingRight,
      stackVerticalPadding: paddingTop,
      stackPaddingBottom: paddingBottom,
    };
    if (hug === 'both' || hug === 'primary') change.stackPrimarySizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
    if (hug === 'both' || hug === 'counter') change.stackCounterSizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
    return this.mutate([change]);
  }

  /** Disable auto-layout (Figma calls this "unstack"). */
  async disableAutoLayout(guid) {
    return this.setStackMode(guid, 'NONE');
  }

  /**
   * Set Hug-contents on one or both axes. Requires the frame to already be in auto-layout
   * (stackMode != NONE) — Figma will silently no-op the sizing change otherwise.
   */
  async setHugContents(guid, { primary = true, counter = true } = {}) {
    const change = { guid: this._guid(guid) };
    if (primary) change.stackPrimarySizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
    if (counter) change.stackCounterSizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
    return this.mutate([change]);
  }

  /** Set fixed sizing on one or both axes. Inverse of setHugContents. */
  async setFixedSize(guid, { primary = true, counter = true } = {}) {
    const change = { guid: this._guid(guid) };
    if (primary) change.stackPrimarySizing = 'FIXED';
    if (counter) change.stackCounterSizing = 'FIXED';
    return this.mutate([change]);
  }

  /**
   * Set padding. Pass either a single number (applied to all 4 sides) or an object
   * { left, right, top, bottom } (any subset).
   */
  async setPadding(guid, padding) {
    const change = { guid: this._guid(guid) };
    if (typeof padding === 'number') {
      change.stackHorizontalPadding = padding;
      change.stackPaddingRight = padding;
      change.stackVerticalPadding = padding;
      change.stackPaddingBottom = padding;
    } else {
      if (padding.left != null) change.stackHorizontalPadding = padding.left;
      if (padding.right != null) change.stackPaddingRight = padding.right;
      if (padding.top != null) change.stackVerticalPadding = padding.top;
      if (padding.bottom != null) change.stackPaddingBottom = padding.bottom;
    }
    return this.mutate([change]);
  }

  /** Set itemSpacing (gap between children in an auto-layout frame). */
  async setSpacing(guid, spacing) {
    return this.mutate([{ guid: this._guid(guid), stackSpacing: spacing }]);
  }

  // --- internal ---

  _guid(g) {
    if (typeof g === 'string') {
      const [s, l] = g.split(':').map(Number);
      return { sessionID: s, localID: l };
    }
    if (g && typeof g === 'object' && 'sessionID' in g && 'localID' in g) return g;
    throw new Error(`Invalid guid: ${JSON.stringify(g)}`);
  }

  /** Close the connection cleanly. */
  async close() {
    if (this._closed) return;
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close(1000);
    });
  }
}
