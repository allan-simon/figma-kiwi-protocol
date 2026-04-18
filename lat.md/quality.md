---
name: Quality & flatten
description: Heuristic scorer that tells an agent whether a Figma subtree's parent/child nesting is trustworthy, plus a Y-banded flattener for the cases where it is not.
type: architecture
---

# Quality & flatten

Two small CLI tools that decide *how* to consume a decoded scenegraph. `quality` scores a subtree GOOD/FAIR/POOR. `flatten` re-expresses POOR subtrees as an absolute-Y-banded flat listing, bypassing unreliable nesting.

## Why

Auto-layout files have a clean hierarchy where nesting mirrors visual structure. Drag-and-drop files have a hierarchy that *lies* — visually adjacent elements sit in unrelated frames, named `Frame 1234567`, overlapping each other.

A to-html agent that trusts parent/child nesting on a drag-and-drop page will hallucinate sections that don't exist. We want a cheap detector that triages the subtree before the agent commits to a structural interpretation.

## bin/quality.mjs

Walks the subtree, counts eight signals, combines them into a single 0-100 score and a verdict (GOOD ≥ 80 / FAIR 50-79 / POOR < 50).

### Signals

Each signal is a ratio in [0, 1]. The weights were tuned against real files — recordpool components (clean auto-layout) score 95+, landing pages drawn drag-and-drop score ~25, mixed pages land in the middle.

- **absoluteRatio** — visible leaves whose parent has no auto-layout. The single strongest signal. Every absolute leaf is a hierarchy lie waiting to mislead the agent.
- **genericNameRatio** — frames named `Frame 1234567`, `Group N`, `Rectangle N`, `Vector`. Designers who care about structure rename their frames.
- **overflowRatio** — children whose bbox extends past the parent's bbox (2 px tolerance). Common in drag-drop when a designer moves a child after its parent was created.
- **mixedLayoutRatio** — auto-layout frames containing at least one `stackPositioning === 'ABSOLUTE'` child. Suggests the designer started clean and then overrode.
- **noLayoutRatio** — non-root frames with ≥ 2 visible children and no auto-layout.
- **rootOrphanRatio** — `RECTANGLE` / `ROUNDED_RECTANGLE` leaves (typically image fills) that are direct children of the root. Suspect drag-dropped images.
- **siblingOverlapRatio** — pairs of non-auto-layout siblings whose bboxes overlap > 4 px in both axes AND are not in a >90 % containment relationship (containment is a background+foreground stack, not a drag-drop overlap). Every overlap is one "designer dropped X on Y" incident.
- **treeYDisorder** — `1 − Spearman(treeRank, yRank)` over the root's visible children. 0 = tree order matches visual Y order, 1 = inverted.

Plus a singleton-chain depth penalty (2 points per level, capped at 6) — deep chains of `frame → frame → frame → one child` indicate wrapper-happy structure.

### Scoring

Linear weighted sum starting from 100, then hard caps. The hard caps matter more than the linear weights: any *one* bad signal drags the verdict down, even if the others are clean.

```
absoluteRatio       > 0.25 → score ≤ 65
absoluteRatio       > 0.50 → score ≤ 35
genericNameRatio    > 0.50 → score ≤ 70
overflowRatio       > 0.15 → score ≤ 55
noLayoutRatio       > 0.30 → score ≤ 60
siblingOverlapRatio > 0.10 → score ≤ 55
treeYDisorder       > 0.30 → score ≤ 60
treeYDisorder       > 0.60 → score ≤ 40
```

### Output

Human mode prints per-signal checkmarks, counts, and a recommendation. `--json` returns the same data as one object — the advice array tells a consuming agent what to do next: trust to-html, cross-reference a render, or flatten.

## bin/flatten.mjs

Used when `quality` returns POOR. Re-expresses the subtree as a flat Y-ordered list of leaves grouped into horizontal bands, bypassing the hierarchy entirely.

### Strategy

Tree nesting is unreliable on POOR subtrees, but absolute positions (composed from each node's transform) are always correct. Sort leaves by absolute Y, split on gaps larger than `--gap` (default 60 px), emit one `<y-band>` per group.

Each leaf in a band carries `data-x`, `data-y`, `data-w`, `data-h`, and its real content — text characters for TEXT, image URL via `image_mapping.json` for RECTANGLE fills, SVG hints for VECTOR. The output is valid HTML the agent can parse directly.

### When to use

Only when `quality` score is POOR. On GOOD subtrees, flat Y-banded output discards the meaningful nesting information the designer encoded — `to-html` is strictly better there.

## Recommended workflow

`quality` is the gatekeeper for a decode-to-code pipeline:

1. Capture + decode (see [[capture]])
2. `figma-kiwi quality <node_id>` — check the verdict
3. If GOOD → `figma-kiwi to-html <node_id>` trusts nesting
4. If FAIR → `to-html` with cross-referenced PNG render
5. If POOR → `figma-kiwi flatten <node_id>` + PNG render, ignore nesting

The JSON output of `quality` is designed to be read by an agent (e.g. the figma-explorer skill) to pick the right branch automatically.
