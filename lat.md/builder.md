# Builder

Minimal helper to author Figma nodes from scratch and produce a flat list of `nodeChanges` ready to feed into `FigmaSession.mutate()`. Used by build-from-scratch scripts that prefer clean structures over patching legacy ones.

## Why a builder

Once you can write to Figma, the temptation is to patch existing components in place. Patching tends to become whack-a-mole.

Existing structures carry implicit dependencies (SPACE_EVENLY ignoring stackSpacing, padding 150 magic numbers, alignment inconsistencies). Authoring from scratch with a clean responsive structure is often faster and more correct.

## lib/builder.mjs

Single class `FigmaBuilder` that allocates guids and fills in the boring required fields.

Sets transform, opacity, visible, stroke defaults, fillPaints automatically. Exposes one factory per node type. Each factory returns a `{guid, ref}` opaque ref the caller passes as the `parent` of children.

### Two wire-format gotchas it handles automatically

Both of these silently break "from scratch" authoring if you don't know about them. They were discovered the hard way, after days of "the field acks but isn't applied".

### `OptionalVector` wrapping for `minSize` / `maxSize`

The Kiwi schema uses an `OptionalVector` struct for these fields, which is `{value: {x, y}}`, NOT `{x, y}`.

If you send the unwrapped form, the encoder produces an empty `OptionalVector` and the server acks the message — but the value never lands. The auto-layout shrink-wrap behaviour you wanted silently doesn't trigger.

```js
// WRONG — encoder serialises this as an empty OptionalVector, server ignores
{ guid, minSize: { x: 320, y: 0 } }

// RIGHT
{ guid, minSize: { value: { x: 320, y: 0 } } }
```

The builder accepts either shape and wraps automatically. The standalone `optionalVector()` helper in [[clone#lib/clone.mjs]] does the same.

### `parentIndex.position` must be unique per sibling

When two siblings share the same `parentIndex.position`, Figma sorts them non-deterministically.

Visual left-to-right order will not match creation order. The fix is to assign a strictly-increasing position string to each new sibling.

The builder tracks a per-parent child counter and auto-generates `"a"`, `"b"`, `"c"`, … for successive children. Lexicographic sort gives the correct visual order.

## bin/build-footer-fresh.mjs

A working example that uses the builder to create a clean responsive Footer component from scratch. Demonstrates the recipe for nested wrap, growable sections with sane minimums, and explicit child ordering.

### Structure

Three sections in HORIZONTAL stack with WRAP, in the same order as the source Footer (CTA Card | Social row | Links 3-col block).

Each section has a `minSize` so it never compresses past readability. When the parent is narrower than the sum of mins, sections wrap to the next line instead of overlapping.

### Suffixed name for iteration

The root frame's name includes a wall-clock timestamp like `Footer (rebuilt 2026-04-06 21:30:18)`.

Successive runs are easy to tell apart in the layers panel — newest one is the latest minute. Avoids the "which of the seven Footer (rebuilt) is the current one" confusion.

## Out of scope today

What the builder does NOT yet do, and why each is non-trivial.

- `TEXT` nodes — TEXT requires a stack of font fields (fontName, fontSize, lineHeight, letterSpacing, fontVariations, textData with characters/lines, fontVersion, textBidiVersion, textUserLayoutVersion, …) that are tedious to author by hand. Easier to clone an existing TEXT leaf from the source and override `characters`.
- `SYMBOL` (main components) — needs componentKey, sharedSymbolVersion, publishID and other publishing metadata. The current builder produces FRAMES; convert manually in Figma if needed.
- `VECTOR` icons — require `vectorNetworkBlob` binary data. Easier to clone the source's icons via [[clone#Deep clone]] than to author from scratch.
