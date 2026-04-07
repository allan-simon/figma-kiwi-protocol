# Auto-layout

Figma's wire format calls auto-layout `stack`, not `layout`. This is the main vocabulary surprise for anyone coming from the Figma plugin API. Use this page as a translation table when implementing high-level write helpers.

## Why this matters

The driving business case is to programmatically convert hardcoded-width frames into auto-layout frames with Hug-contents sizing.

Designers can then be shown a concrete diff instead of a verbal nudge. Every helper that enables auto-layout has to know these field names.

## Field mapping

The wire-format names (left) come from the Kiwi schema embedded in figma_decoder.js. The plugin-API names (right) are what Figma's docs call them. They differ enough that grepping won't find the connection.

| Wire (`stack*`) | Plugin API |
|---|---|
| `stackMode` | `layoutMode` |
| `stackSpacing` | `itemSpacing` |
| `stackHorizontalPadding` | `paddingLeft` |
| `stackPaddingRight` | `paddingRight` |
| `stackVerticalPadding` | `paddingTop` |
| `stackPaddingBottom` | `paddingBottom` |
| `stackPrimarySizing` | `primaryAxisSizingMode` |
| `stackCounterSizing` | `counterAxisSizingMode` |
| `stackPrimaryAlignItems` | `primaryAxisAlignItems` |
| `stackCounterAlignItems` | `counterAxisAlignItems` |
| `stackWrap` | `layoutWrap` |
| `stackChildPrimaryGrow` | `layoutGrow` (on the child) |
| `stackChildAlignSelf` | `layoutAlign` (on the child) |
| `minSize` / `maxSize` | `minWidth` / `maxWidth` and friends |

### `stackMode` values

`"NONE"` is the default for non-auto-layout frames. The other three each appear in distinct mutation patterns observed in capture.

- `"NONE"` — auto-layout disabled
- `"VERTICAL"` — vertical auto-layout
- `"HORIZONTAL"` — horizontal auto-layout
- `"GRID"` — Figma's 2024 grid auto-layout (uses additional `gridRows`, `gridColumns`, `gridRowGap`, `gridColumnGap`, `gridColumnsSizing`, `gridRowsSizing` fields)

### `stackPrimarySizing` / `stackCounterSizing` values

Two values dominate. The "Hug contents" mode is the one we care about for the business goal of fluid layouts.

- `"FIXED"` — fixed pixel size on that axis
- `"RESIZE_TO_FIT"` — Hug contents (older variant, sometimes seen on legacy nodes)
- `"RESIZE_TO_FIT_WITH_IMPLICIT_SIZE"` — Figma's current "Hug contents"

There is no `FILL` value here. "Fill container" for a child is set on the child, not the parent — see [[auto-layout#Auto-layout#Field mapping#Child-side fields]] below.

### `stackWrap` values

Auto-layout wrap (released ~2024). Lets a horizontal row break into multiple rows when the parent is too narrow, mirroring CSS `flex-wrap`.

- `"NO_WRAP"` — default, single line/column
- `"WRAP"` — children flow onto a new line when they don't fit

When `stackWrap: "WRAP"` is set, `stackCounterAxisSpacing` controls the gap between wrapped lines.

### `stackPrimaryAlignItems` / `stackCounterAlignItems` values

Distribution / alignment of children inside the auto-layout frame. Maps to CSS `justify-content` (primary) and `align-items` (counter).

- `"MIN"` — pack at start (left for HORIZONTAL, top for VERTICAL)
- `"CENTER"` — pack at centre
- `"MAX"` — pack at end
- `"SPACE_BETWEEN"` — distribute evenly with first/last at the edges (primary axis only)

### Child-side fields

Set on the children themselves to override default sizing behaviour relative to the parent. These map to CSS flex item properties.

- `stackChildPrimaryGrow` — number, 0 or 1. CSS `flex-grow`. Set to 1 to make the child fill the remaining space on the parent's primary axis. This is the wire-format equivalent of "Fill container" on the primary axis.
- `stackChildAlignSelf` — `"AUTO"` | `"STRETCH"` | `"MIN"` | `"CENTER"` | `"MAX"`. Override of `stackCounterAlignItems` for this one child. `"STRETCH"` is "Fill container" on the counter axis.
- `minSize` / `maxSize` — `{x:N, y:N}`. Hard bounds the child must respect even if its parent is auto-layout-shrinking it. Critical for responsive layouts where you want a card to never collapse below a readable width.

## Minimal mutation examples

Each is what gets sent inside `nodeChanges[]`. The wrapping `Message` envelope is the same as for any write — see [[wire-protocol#Message envelope]].

### Toggle auto-layout direction

Single-field update on an existing auto-layout frame. The smallest possible mutation in the Figma protocol — frame #4 of our autolayout capture was 154 bytes on the wire for exactly this.

```js
{ guid: { sessionID: S, localID: L }, stackMode: 'HORIZONTAL' }
```

### Enable auto-layout from scratch (Shift+A)

Captured under the `stack-selection/keyboard-shortcut` action label. Sets sensible defaults — 10px padding on every side, 10px spacing.

```js
{
  guid: { sessionID: S, localID: L },
  stackMode: 'VERTICAL',
  stackSpacing: 10,
  stackHorizontalPadding: 10,
  stackVerticalPadding: 10,
  stackPaddingRight: 10,
  stackPaddingBottom: 10,
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
}
```

### Make a frame Hug contents on both axes

The mutation we expect to send most often when fixing legacy hardcoded-width frames. Requires the frame to already be in auto-layout mode (`stackMode != "NONE"`).

```js
{
  guid: { sessionID: S, localID: L },
  stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
}
```

### Make a row wrap on small widths

The pattern for a real responsive horizontal layout. Combines wrap, growable children with sane minimums, and counter-axis stretch so wrapped rows align cleanly.

```js
// On the parent (the row that will wrap)
{ guid: rootGuid,
  stackMode: 'HORIZONTAL',
  stackWrap: 'WRAP',
  stackSpacing: 32,
  stackHorizontalPadding: 48, stackPaddingRight: 48,
  stackVerticalPadding: 48,   stackPaddingBottom: 48,
  stackPrimarySizing: 'FIXED',                       // resize-driven by user
  stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', // grow tall as rows wrap
}

// On each child that should grow + have a min readable width
{ guid: childGuid,
  stackChildPrimaryGrow: 1,
  minSize: { x: 280, y: 0 },
}
```

When the parent shrinks below `child_minSize_sum + spacing + padding`, children flow to a new line instead of compressing past their min.

## Pitfalls

Things that ack at the wire level but produce surprising visual results. Each was discovered the hard way.

### `SPACE_EVENLY` ignores `stackSpacing`

When `stackPrimaryAlignItems` is `"SPACE_EVENLY"` (or `"SPACE_BETWEEN"`), Figma distributes the available space between children and the explicit `stackSpacing` value is ignored.

The bigger problem: when the parent is resized smaller than the sum of the children's widths, the gap goes negative — children **overlap** silently. There is no built-in floor. Combine `SPACE_EVENLY` with `minSize` on each child if you need it to remain safe under shrink, or use `"MIN"` justify with a fixed gap.

### `minSize` accepts the wrong shape silently

The wire format wraps `minSize` and `maxSize` in an `OptionalVector`. See [[builder]] for the exact gotcha and the auto-wrap helper.

## Action labels worth knowing

When reading `editScopeInfo.snapshots[].frames[].stack[].label` in captured frames, these labels mark the user actions that touch auto-layout. Useful for filtering captures when reverse-engineering more complex behaviours.

- `stack-selection/keyboard-shortcut` — Shift+A initial enable
- `stack-selected-nodes` — right-panel direction toggle
- `unstack-selection` — disable auto-layout
- `change-stack-layout-size` — change sizing modes
- `update-transform-properties` — touches `minSize` etc.
