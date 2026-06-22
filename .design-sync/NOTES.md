# design-sync notes

## This is an off-script, tokens-and-styles-only sync

SRR's `frontend/` is a **Parcel single-page app, not a component library**: zero
runtime UI deps, no React/Vue/web-components, no exported components with a Props
API, no Storybook. The standard design-sync converter (which ships a compiled
component library so Claude Design builds with the customer's real components) does
**not** apply — there are no components to bundle.

The user chose a **tokens + styles only** import: ship SRR's design language so
Claude Design uses its palette/type. Target project: `SRR`
(`13b99a0b-d0bf-415e-9940-7efd6a9940b5`).

## How `ds-bundle/` is built (hand-built, no converter)

`ds-bundle/` is a build artifact (gitignored), regenerable from `frontend/src/`:

```sh
rm -rf ds-bundle && mkdir -p ds-bundle/tokens ds-bundle/fonts
cp frontend/src/tokens.css ds-bundle/tokens/tokens.css
cp .design-sync/fonts.css ds-bundle/fonts/fonts.css
grep -v '@import "./tokens.css";' frontend/src/styles.css > ds-bundle/components.css
printf '%s\n' '/* SRR styling entry — designs receive this file'"'"'s @import closure. */' \
  '@import "./fonts/fonts.css";' '@import "./tokens/tokens.css";' '@import "./components.css";' > ds-bundle/styles.css
cp .design-sync/conventions.md ds-bundle/README.md
```

- `styles.css` is the **entry** (designs receive its `@import` closure): fonts, then tokens, then the `.srr-*` component styles.
- `components.css` = `frontend/src/styles.css` minus its own `@import "./tokens.css"` (the entry imports tokens instead).
- `tokens/tokens.css` = `frontend/src/tokens.css` verbatim — the reusable part.
- `fonts/fonts.css` = `.design-sync/fonts.css` — empty no-op (no webfonts; tokens use system stacks).
- `README.md` = `.design-sync/conventions.md` (the design-agent conventions header; edit the source copy, not the build output).

### Fonts — system stacks only, no webfonts

The tokens use **system font stacks only** — `--font-sans`/`--font-mono`/`--font-serif`
in `tokens.css` lead with `system-ui`/`ui-monospace`/`ui-serif` and their platform
fallbacks; there are **no brand webfonts** and **no CDN font dependency**.
`.design-sync/fonts.css` is therefore an empty no-op, still copied to
`ds-bundle/fonts/fonts.css` and `@import`ed by `styles.css` so the build recipe is
unchanged. Earlier syncs loaded brand webfonts (JetBrains Mono / Charter) — first
self-hosted `fonts/*.woff2`/`*.ttf` binaries, then CDN `@import`s; both were removed.
The re-sync deletes everything under `fonts/` except the rebuilt (empty) `fonts.css`.

### ⚠ In-app edits to managed files get OVERWRITTEN

A re-sync overwrites the four managed files (`styles.css`, `tokens/tokens.css`,
`components.css`, `README.md`) with the repo's build. The user's *added* files
(`fonts/`, `screenshots/`, `*.html`, `*.jsx`, …) are outside the plan's write/delete
scope and are preserved — but any edit made to the four managed files **inside the app**
is clobbered on the next sync. Make styling changes in the repo (`frontend/src/`), not
in the Claude Design project.

## Re-sync procedure

1. Re-run the build commands above.
2. Re-validate the conventions header token names against the fresh `tokens/tokens.css` (see the skill's "Author the conventions header" validation pass); update `.design-sync/conventions.md` if a token was renamed/removed.
3. `finalize_plan` (writes/deletes: `fonts/**`, `tokens/**`, `styles.css`, `components.css`, `README.md`, `_ds_needs_recompile`) → sentinel-fence → upload → reconcile-delete any `fonts/*` binary the build no longer ships (keep `fonts/fonts.css`) → re-arm sentinel.

No `_ds_sync.json` anchor is emitted (off-script) — re-sync simply re-uploads the 4 styling files, which is trivially cheap. Do **not** run `package-build.mjs`/`resync.mjs` here; they expect a component library and will fail.
