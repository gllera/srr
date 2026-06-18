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
rm -rf ds-bundle && mkdir -p ds-bundle/tokens
cp frontend/src/tokens.css ds-bundle/tokens/tokens.css
grep -v '@import "./tokens.css";' frontend/src/styles.css > ds-bundle/components.css
printf '%s\n' '/* SRR styling entry — designs receive this file'"'"'s @import closure. */' \
  '@import "./fonts/fonts.css";' '@import "./tokens/tokens.css";' '@import "./components.css";' > ds-bundle/styles.css
cp .design-sync/conventions.md ds-bundle/README.md
```

- `styles.css` is the **entry** (designs receive its `@import` closure): fonts, then tokens, then the `.srr-*` component styles.
- `components.css` = `frontend/src/styles.css` minus its own `@import "./tokens.css"` (the entry imports tokens instead).
- `tokens/tokens.css` = `frontend/src/tokens.css` verbatim — the reusable part.
- `README.md` = `.design-sync/conventions.md` (the design-agent conventions header; edit the source copy, not the build output).

### Fonts — a PROJECT-ONLY addition (not in the repo)

The SRR **app** uses zero-byte system font stacks (deliberate). But the Claude Design
**project** has real webfonts added in-app: `fonts/` (JetBrains Mono variable + Charter)
+ `fonts/fonts.css` (@font-face), which `styles.css` `@import`s so designs get the real
families named in the token stacks. **These font files live only in the design project,
not this repo** — the build re-adds the `@import "./fonts/fonts.css";` line so a re-sync
doesn't unwire them (it 404s harmlessly if `fonts/` is ever absent, e.g. a fresh project).
The token font-family declarations are still **system-first** (`ui-monospace`/`ui-serif`
ahead of `"JetBrains Mono"`/`"Charter"`); flip the order in `tokens.css` if the webfonts
should be primary.

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
3. `finalize_plan` (writes/deletes: `tokens/**`, `styles.css`, `components.css`, `README.md`, `_ds_needs_recompile`) → sentinel-fence → upload → re-arm sentinel.

No `_ds_sync.json` anchor is emitted (off-script) — re-sync simply re-uploads the 4 styling files, which is trivially cheap. Do **not** run `package-build.mjs`/`resync.mjs` here; they expect a component library and will fail.
