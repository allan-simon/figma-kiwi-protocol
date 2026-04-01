meta:
  id: figma_commands_blob
  title: Figma commandsBlob — pre-computed SVG path commands
  license: MIT
  endian: le
  file-extension: bin

doc: |
  Figma stores pre-computed vector geometry as a binary blob of SVG-like
  path commands. Each command is a single byte followed by float32 LE
  coordinate pairs. This format is found in `fillGeometry[].commandsBlob`
  and `strokeGeometry[].commandsBlob` fields of VECTOR nodes in the
  decoded Kiwi scenegraph.

seq:
  - id: commands
    type: command
    repeat: eos

types:
  command:
    seq:
      - id: opcode
        type: u1
        enum: opcode_type
      - id: body
        type:
          switch-on: opcode
          cases:
            opcode_type::move_to: point
            opcode_type::line_to: point
            opcode_type::cubic_bezier: cubic_bezier_params
            opcode_type::close_path: void_body
            opcode_type::separator: void_body

  point:
    doc: A 2D coordinate (x, y) as float32 LE.
    seq:
      - id: x
        type: f4
      - id: y
        type: f4

  cubic_bezier_params:
    doc: |
      Two control points (cp1, cp2) and the end point, matching
      the SVG `C` command: C cp1x,cp1y cp2x,cp2y x,y
    seq:
      - id: cp1_x
        type: f4
      - id: cp1_y
        type: f4
      - id: cp2_x
        type: f4
      - id: cp2_y
        type: f4
      - id: x
        type: f4
      - id: y
        type: f4

  void_body:
    doc: No parameters — ClosePath and separator carry no data.
    seq: []

enums:
  opcode_type:
    0x00: separator
    0x01: move_to
    0x02: line_to
    0x03: close_path
    0x04: cubic_bezier
