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

### `stackMode` values

`"NONE"` is the default for non-auto-layout frames. The other three each appear in distinct mutation patterns observed in capture.

- `"NONE"` — auto-layout disabled
- `"VERTICAL"` — vertical auto-layout
- `"HORIZONTAL"` — horizontal auto-layout
- `"GRID"` — Figma's 2024 grid auto-layout (uses additional `gridRows`, `gridColumns`, `gridRowGap`, `gridColumnGap`, `gridColumnsSizing`, `gridRowsSizing` fields)

### `stackPrimarySizing` / `stackCounterSizing` values

Two values dominate. The "Hug contents" mode is the one we care about for the business goal of fluid layouts.

- `"FIXED"` — fixed pixel size on that axis
- `"RESIZE_TO_FIT_WITH_IMPLICIT_SIZE"` — Figma's "Hug contents"

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

## Action labels worth knowing

When reading `editScopeInfo.snapshots[].frames[].stack[].label` in captured frames, these labels mark the user actions that touch auto-layout. Useful for filtering captures when reverse-engineering more complex behaviours.

- `stack-selection/keyboard-shortcut` — Shift+A initial enable
- `stack-selected-nodes` — right-panel direction toggle
- `unstack-selection` — disable auto-layout
- `change-stack-layout-size` — change sizing modes
- `update-transform-properties` — touches `minSize` etc.
