meta:
  id: figma_vector_network_blob
  title: Figma vectorNetworkBlob — editable vector path data
  license: MIT
  endian: le
  file-extension: bin

doc: |
  Figma's original editable path representation, before expansion into
  commandsBlob. Stores vertices (points), segments (edges with tangent
  handles), and regions (closed areas). Found in
  `vectorData.vectorNetworkBlob` of VECTOR nodes in the decoded Kiwi
  scenegraph.

  Segments connect vertices via cubic Bezier curves. Each segment stores
  tangent offsets (relative to the vertex position) for the two control
  points. A straight line has zero tangents.

seq:
  - id: vertex_count
    type: u4
  - id: segment_count
    type: u4
  - id: region_count
    type: u4
  - id: vertices
    type: vertex
    repeat: expr
    repeat-expr: vertex_count
  - id: segments
    type: segment
    repeat: expr
    repeat-expr: segment_count
  - id: regions
    type: region
    repeat: expr
    repeat-expr: region_count

types:
  vertex:
    doc: |
      A point in the vector network. Flags are not fully understood yet
      but appear to encode corner style and mirroring.
    seq:
      - id: flags
        type: u4
      - id: x
        type: f4
      - id: y
        type: f4

  segment:
    doc: |
      An edge connecting two vertices with optional Bezier tangent handles.
      Tangent values are offsets relative to the vertex position:
        control_point_1 = vertices[start].pos + (tangent_start_x, tangent_start_y)
        control_point_2 = vertices[end].pos   + (tangent_end_x, tangent_end_y)
      When all tangent values are zero, the segment is a straight line.
    seq:
      - id: flags
        type: u4
      - id: start_vertex_idx
        type: u4
      - id: tangent_start_x
        type: f4
      - id: tangent_start_y
        type: f4
      - id: end_vertex_idx
        type: u4
      - id: tangent_end_x
        type: f4
      - id: tangent_end_y
        type: f4

  region:
    doc: |
      A closed area defined by one or more loops of segments.
      Winding rule: 0 = NONZERO, 1 = EVENODD.
      Each loop lists the segment indices that form a closed path.
    seq:
      - id: winding_rule
        type: u4
        enum: winding_rule_type
      - id: loop_count
        type: u4
      - id: loops
        type: loop
        repeat: expr
        repeat-expr: loop_count

  loop:
    doc: A closed path within a region, defined by a sequence of segment indices.
    seq:
      - id: segment_index_count
        type: u4
      - id: segment_indices
        type: u4
        repeat: expr
        repeat-expr: segment_index_count

enums:
  winding_rule_type:
    0: nonzero
    1: evenodd
