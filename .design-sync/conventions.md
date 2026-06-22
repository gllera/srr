# SRR — design tokens & styling

This is a **token-and-styles design system, not a component library.** SRR (Static
RSS Reader) is a plain-DOM app with zero runtime UI deps — there are no React/web
components to instantiate. What ships here is SRR's **visual language**: design
tokens plus the app's reference stylesheet. **Build UI with the tokens below**;
don't expect a `<Button>`/`<Card>` API.

## Styling idiom: CSS custom properties

Style everything through `var(--token)` — colors, type, spacing, elevation, and
stacking all come from tokens. **Never hard-code a hex color or a z-index:** the
tokens reassign themselves under `@media (prefers-color-scheme: dark)` and
`(prefers-contrast: more)`, so using the vars gets you dark mode and high-contrast
for free. Hard-coded values opt out of all of that.

## Token vocabulary (all defined in `tokens/tokens.css`)

**Color** — `--bg` (page surface), `--surface-raised` (menus / popups / dialogs — a
hair lighter than `--bg` so cards lift off the page), `--fg` (primary ink), `--fg-2`
(dimmed ink for read / secondary text — still legible, unlike `--muted`), `--muted`
(metadata / chrome only — intentionally below AA for body text, so don't use it for
content), `--faint` (in-flow hairlines / dividers), `--border` (component edges —
cards/menus, a touch stronger than `--faint`), `--hover` (hover wash), `--accent`
(the one brand accent — a muted terracotta; use sparingly for the primary action /
active state).

**Per-source accent** — set `data-src="0"`…`data-src="7"` on an element and read
`var(--src)`: a uniform 8-slot OKLCH ramp (one lightness + chroma, 8 hues spread
evenly so neighbours don't clash; light + dark variants) for color-coding by
origin/category. SRR keys each feed to a slot; reuse it anywhere you want stable
categorical color (rails, eyebrows, badges).

**Shape** — `--radius` (4px corners), `--shadow` (the elevation shadow for popups/cards).

**Type** — three roles, deliberately paired ("wire chrome wraps human prose"):
`--font-sans` for UI chrome, `--font-mono` for metadata/wire labels (e.g. a
`source · age` eyebrow), and `--font-serif` for reading prose. All three are
**system font stacks** (`system-ui` / `ui-monospace` / `ui-serif` and their platform
fallbacks) — no webfonts, no CDN font dependency. Scale (1.125 ratio): `--text-sm`,
`--text-base`, `--text-lg`, `--text-xl`.

**Spacing** — `--space-1` (0.25rem), `--space-2` (0.5rem), `--space-3` (0.75rem),
`--space-4` (1rem), `--space-5` (1.5rem), `--space-6` (2rem).

**Stacking** — use these instead of literal z-indexes: `--z-sticky` (1, pinned
dividers), `--z-searchbar` (5), `--z-toolbar` (6), `--z-popup` (1000), `--z-popup-top`
(1001).

## Where the truth lives

- `tokens/tokens.css` — the full token set and its dark / high-contrast reassignments. Read it before styling.
- `components.css` — SRR's own `.srr-*` rules. **Reference only:** those classes are bound to SRR's specific DOM, not a reusable utility vocabulary. Mine them to see how the tokens compose into real UI; style new screens with the tokens, not by reaching for `.srr-*`.

## Idiomatic snippet

```html
<article data-src="2" style="
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--faint); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: var(--space-3);
    font-family: var(--font-sans);">
  <div style="font-family: var(--font-mono); font-size: var(--text-sm);
              color: var(--src); text-transform: uppercase;">
    The Verge · 4h ago
  </div>
  <h2 style="font-size: var(--text-xl); color: var(--fg);">Headline goes here</h2>
  <p style="font-family: var(--font-serif); color: var(--muted);">
    Body prose in the serif reading voice.
  </p>
  <button style="background: var(--accent); color: var(--bg);
                 border: 0; border-radius: var(--radius);
                 padding: var(--space-1) var(--space-3);">Open</button>
</article>
```
