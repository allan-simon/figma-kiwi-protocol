meta:
  id: figma_fig_wire_frame
  title: Figma fig-wire WebSocket frame — Kiwi schema delivery
  license: MIT
  endian: le
  file-extension: bin

doc: |
  The first binary WebSocket frame sent by Figma's server when a file is
  opened. Contains a magic header, a version number, and a
  zstd-compressed Kiwi schema definition (~558 types as of 2026).

  The schema is needed to decode all subsequent data frames, which carry
  the scenegraph as Kiwi-encoded `Message` objects.

  To use the schema:
    1. Extract the compressed bytes (offset 12 to end)
    2. Decompress with zstd
    3. Feed the raw binary to the Kiwi CLI to generate a decoder:
       `kiwi --schema schema_raw.bin --js decoder.js`

seq:
  - id: magic
    contents: "fig-wire"
  - id: version
    type: u4
  - id: compressed_schema
    size-eos: true
    doc: zstd-compressed Kiwi schema binary (magic bytes 28 B5 2F FD)
