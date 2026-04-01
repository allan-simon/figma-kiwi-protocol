// Figma Kiwi schema extraction and decoder generation.
// Pure functions — no I/O, no side effects.
//
// Figma uses Kiwi (by Evan Wallace) as its binary serialization format.
// The schema is transmitted in the first WebSocket frame (fig-wire header)
// and defines ~558 types used to encode the scenegraph.

/**
 * Check if a buffer is a fig-wire frame (contains the Kiwi schema).
 * Layout: "fig-wire" (8 bytes) + version (4 bytes) + zstd-compressed schema
 */
export function isFigWireFrame(buf) {
  if (buf.length < 12) return false;
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  return magic === 'fig-wire';
}

/**
 * Extract the raw Kiwi schema binary from a fig-wire frame.
 * Returns the zstd-compressed schema bytes (caller must decompress).
 */
export function extractCompressedSchema(figWireBuf) {
  if (!isFigWireFrame(figWireBuf)) {
    throw new Error('Not a fig-wire frame');
  }
  // Skip: "fig-wire" (8 bytes) + version uint32 (4 bytes)
  return figWireBuf.subarray(12);
}

/**
 * Check if a buffer is zstd-compressed (magic bytes: 28 B5 2F FD).
 */
export function isZstdCompressed(buf) {
  return buf.length >= 4 &&
    buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
}
