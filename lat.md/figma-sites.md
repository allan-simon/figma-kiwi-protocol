# Figma Sites & responsive sets

Figma's native breakpoint and responsive scaling system, discovered in the schema but not used by any node in the typical design library.

Important to know about so you don't try to invent your own breakpoint solution when there's already one in the protocol.

## What it is

Responsive sets are the wire-format foundation of **Figma Sites**, Figma's product for publishing designs as actual websites. They are NOT a general-purpose design system feature.

The same struct (`responsiveSetSettings`) holds both breakpoint logic AND web-publishing metadata: `lang`, `faviconHash`, `socialImageHash`, `googleAnalyticsID`, `customCodeHeadStart/End`, `customCodeBodyStart/End`, `blockSearchIndexing`. The juxtaposition makes the intent unambiguous: this is for sites, not for components inside other Figma files.

## When to use it (and when not)

Two completely different use cases pull on responsive primitives. Pick the right one or you'll fight Figma.

### Use it for: Figma Sites pages

A frame that will be published as a real web page. Breakpoints fire based on the published page's viewport width. The responsive set is the natural unit.

### Don't use it for: design library components

A component that will be embedded in other Figma designs and resized inside whatever parent Frame it's dropped into.

Responsive sets do NOT respond to per-instance container width — only to the published page width. For library components, use [[auto-layout]] (`stackWrap` + `minSize`).

## Schema fields

Discovered via grep on the figma_decoder.js generated codec. None of these are present on any node in a typical design-system file — the feature is opt-in and only activated by Figma Sites users.

### On any node

These fields can appear on any frame to mark it as part of a responsive set or as a breakpoint variant within one.

- `isResponsiveSet: bool` — marks a frame as the root of a responsive set
- `defaultResponsiveSetId: GUID` — the default breakpoint guid
- `isPrimaryBreakpoint: bool` — marks a child frame as the "base" breakpoint
- `primaryResponsiveNodeId: GUID` — points back at the root from inside a breakpoint
- `breakpointMinWidth: float` — the viewport width at which this breakpoint activates
- `isBreakpointInFocus: bool` — UI-only flag for which breakpoint the editor is currently editing
- `derivedBreakpointData: { overrides: NodeChange[] }` — the list of mutations that apply when this breakpoint is active. Equivalent to a CSS `@media (min-width: N) { ... }` block: each override is a partial nodeChange that overrides default field values.

### `responsiveSetSettings` — site-level metadata

A struct attached to the responsive set root. The fields make it clear this is for publishing, not for design system use.

- `title`, `description`, `lang` — page metadata
- `faviconHash`, `socialImageHash` — favicon and OG image asset hashes
- `googleAnalyticsID`, `blockSearchIndexing` — tracking + SEO controls
- `customCodeHeadStart`, `customCodeHeadEnd`, `customCodeBodyStart`, `customCodeBodyEnd` — raw HTML injection
- `scalingMode`: `REFLOW` | `SCALE` — how content adapts between breakpoints
- `scalingMinFontSize`, `scalingMaxFontSize` — font scaling bounds
- `scalingMinLayoutWidth`, `scalingMaxLayoutWidth` — interpolation range, equivalent to CSS `clamp(minSize, fluid, maxSize)`

### `responsiveTextStyleVariants`

Text nodes can carry an array of style variants, each tagged with a `minWidth` threshold. The Figma renderer picks the variant whose threshold matches the current breakpoint width. This is fluid typography on a per-text basis.

## CSS equivalence table

How the CSS-side concepts map to what Figma actually exposes. Useful when explaining the trade-offs to a designer.

| CSS | Figma equivalent | Where it lives |
|---|---|---|
| `display: flex; flex-wrap: wrap` | `stackWrap: WRAP` | Any auto-layout frame |
| `min-width` | `minSize` (OptionalVector) | Any auto-layout child |
| `@media (min-width: N)` | `breakpointMinWidth` + `derivedBreakpointData.overrides` | Responsive sets only — Figma Sites |
| `clamp(min, fluid, max)` font scaling | `scalingMinFontSize` + `scalingMin/MaxLayoutWidth` | Responsive sets only |
| `@container (min-width: N)` | **Nothing** | — |

## No container queries

Figma has no equivalent of CSS container queries. A library component cannot automatically change padding / sizing / structure based on the size of the box it's been dropped into. The closest workarounds:

1. `stackWrap` + `minSize` — flow responsiveness, no discrete states
2. Component variants (`componentPropDefs`) with a `Density=compact|comfortable` prop that the designer toggles manually per instance

This is the structural limit of what Figma can do natively for component-level responsiveness, as of the schema this project decoded.

## Reverse-engineering responsive sets

Not yet attempted. The schema gives us the field shapes, but the actual sequencing (do you create breakpoint frames first then mark the parent? does the server compute `derivedBreakpointData` or does the client?) is unknown.

To reverse it empirically: capture the wire frames sent when a Figma Sites user creates a responsive set + adds a breakpoint + edits a property in the second breakpoint, then decode the sequence. Same approach as how we reversed `stackMode` toggles via [[capture]].
