# Feed Recipes — Design Spec

**Date:** 2026-06-21
**Status:** Approved (design); ready for implementation planning
**Scope:** SRR backend (`backend/`) + a small frontend display change (`frontend/`)

## Problem

Today a feed's processing is configured on two axes (ingest strategy + mod pipeline)
at two levels (db.gz root defaults and per-feed overrides):

- `DBCore.Pipe []string` / `DBCore.Ingest string` (JSON `pipe`/`ingest`) — root defaults,
  managed by `srr pipe` / `srr ingest`.
- `Feed.Pipe []string` / `Feed.Ingest string` (JSON `pipe`/`ingest`) — per-feed overrides,
  managed by `srr feed add/upd -p/-i`. An empty feed pipe/ingest inherits root; the `#base`
  token in a feed pipe expands the root pipe inline.

Configuration is therefore duplicated across feeds: two feeds that want the same
`{ingest, pipe}` each carry their own copy, and changing the shared setup means editing
every feed.

## Goal

Introduce **named `{ingest, pipe}` recipes** stored once in db.gz. Feeds **reference** a
recipe by name instead of carrying their own inline ingest/pipe. This centralizes
processing config and lets many feeds share one definition edited in one place.

## Decisions (locked)

1. **Reserved `default` recipe.** The `recipes` map always contains a `default` entry,
   seeded from today's root pipe (`["#sanitize", "#minify"]`). A feed with no recipe
   reference resolves to `default`. The separate root `pipe`/`ingest` fields go away —
   `default` is the new home for what they expressed.
2. **Clean-break migration.** The new binary strips legacy root and per-feed `pipe`/`ingest`
   (the struct fields are removed, so `json.Unmarshal` drops the keys). Every existing feed
   reverts to `default`. The operator re-creates any non-default recipe by hand and
   re-points the feeds that need it. No auto-migration, no migrate command. This matches the
   existing rebuild-the-store operational workflow.
3. **`#default` composition token (renamed from `#base`).** A recipe's pipe may contain
   `#default`, which expands inline to the **`default` recipe's** pipe. The `default` recipe's
   own pipe forbids `#default` (it *is* the default). The backend const `pipeBase = "#base"`
   becomes `pipeDefault = "#default"` and the `validatePipe` param `allowBase` becomes
   `allowDefault`.
4. **Naming: "recipe".** Wire key `recipes` (map), feed field `recipe` (string),
   CLI command `srr recipe`.
5. **`srr pipe` / `srr ingest` removed.** The `default` recipe is edited through the same
   `srr recipe set` path as any other recipe. One way to manage everything.

## Data Model

New struct + two struct edits in `backend/`:

```go
// Recipe is a named {ingest, pipe} bundle referenced by feeds.
type Recipe struct {
    Ingest string   `json:"ingest,omitempty"`
    Pipe   []string `json:"pipe,omitempty"`
}
```

- **`DBCore`** (`backend/db.go`): remove `Pipe []string` (`json:"pipe,omitempty"`) and
  `Ingest string` (`json:"ingest,omitempty"`). Add:
  ```go
  Recipes map[string]Recipe `json:"recipes,omitempty"`
  ```
- **`Feed`** (`backend/feed.go`): remove `Pipe []string` (`json:"pipe,omitempty"`) and
  `Ingest string` (`json:"ingest,omitempty"`). Add:
  ```go
  Recipe string `json:"recipe,omitempty"` // empty ⇒ "default"
  ```
- New const `defaultRecipeName = "default"` (`backend/db.go`). `defaultRootPipe()`
  (`["#sanitize", "#minify"]`) stays — it seeds the `default` recipe's pipe.

### Wire shape (db.gz)

```yaml
recipes:
  default:     { pipe: ["#sanitize", "#minify"] }          # ingest empty ⇒ #feed
  readability: { pipe: ["#readability", "#default"] }       # ⇒ #readability,#sanitize,#minify
  telegram:    { ingest: "srr-telegram", pipe: ["#sanitize"] }
feeds:
  7: { url: "...", recipe: "readability" }   # named
  9: { url: "..." }                          # no recipe ⇒ "default"
```

## Resolution Semantics

Resolution reuses today's two helper functions unchanged — only the fallback source moves
from `DBCore.Pipe`/`DBCore.Ingest` to the `default` recipe.

**Each axis falls back to `default` independently.** `ingest` and `pipe` are resolved
separately, so a recipe may define one and omit the other. A recipe that sets only `ingest`
(empty/absent `pipe`) uses its own ingest **and `default`'s pipe**; a recipe that sets only
`pipe` uses its own pipe **and `default`'s ingest**. An empty field is never "no value" — it
always means "take `default`'s." (The `default` recipe itself has nothing to fall back to:
its own non-empty `pipe` is used as-is, and its empty `ingest` falls through to the built-in
`#feed`.)

- **`recipeFor(recipes map[string]Recipe, name string) Recipe`** (new, free function in
  `backend/db.go`): returns `recipes[name]`; an empty or unknown name returns
  `recipes[defaultRecipeName]`. Lenient: a dangling reference never crashes a fetch — it
  silently resolves to `default`. The CLI prevents *creating* dangling refs (see Validation),
  so this is a safety net, not the normal path. A thin method `db.recipeFor(name)` wraps it
  over `db.core.Recipes` for CLI/command callers. Operating on a plain map (not the `*DB`)
  lets the fetch path resolve recipes from `fetchRun` without threading the whole DB through
  `Feed.Fetch`.
- **Pipe**: `resolvePipe(defaultRecipe.Pipe, recipe.Pipe)` — the existing function
  (`backend/feed.go`), unchanged. Empty recipe pipe inherits `default`; a non-empty pipe
  overrides; `#default` expands to `default`'s pipe.
- **Ingest**: `ingest.Select(recipe.Ingest, defaultRecipe.Ingest)` — the existing function
  (`backend/ingest/main.go`), unchanged. Empty recipe ingest inherits `default`'s, then the
  built-in `#feed`.

### Fetch path

`fetchRun` (the run-scoped bundle in `backend/feed.go`) currently carries `rootPipe`
/`rootIngest`. It replaces them with `recipes map[string]Recipe` (the full map, read-only
during a fetch run), populated once in `FetchCmd.fetch` from `db.core.Recipes`.

`Feed.Fetch` (`backend/feed.go`) resolves the feed's recipe once at the top, using the map on
`run`:

1. `r := recipeFor(run.recipes, c.Recipe)`
2. `def := recipeFor(run.recipes, defaultRecipeName)`
3. `pipe := resolvePipe(def.Pipe, r.Pipe)`; `processor.Validate(ctx, pipe)` (unchanged).
4. `ingestName := ingest.Select(r.Ingest, def.Ingest)` (unchanged).

## NewDB / Migration

`NewDB` (`backend/db.go`):

- Fields removed ⇒ `json.Unmarshal` silently drops legacy root `pipe`/`ingest` and per-feed
  `pipe`/`ingest` keys from an old db.gz. Every feed's `Recipe` is `""` ⇒ resolves to
  `default`. (Clean break — confirmed acceptable.)
- Seed the `default` recipe when absent, mirroring today's
  `if db.core.Pipe == nil { db.core.Pipe = defaultRootPipe() }`:
  ```go
  if db.core.Recipes == nil {
      db.core.Recipes = map[string]Recipe{}
  }
  if _, ok := db.core.Recipes[defaultRecipeName]; !ok {
      db.core.Recipes[defaultRecipeName] = Recipe{Pipe: defaultRootPipe()}
  }
  ```
  Persisted on the next `Commit`.
- The existing `NewDB` range-check + empty-URL rejection of feeds is unchanged.

## CLI

### New: `srr recipe` group (`backend/cmd_recipe.go`)

- `srr recipe ls` — print all recipes (JSON/YAML, matching `srr feed ls` conventions).
- `srr recipe show <name>` — print one recipe; error if missing.
- `srr recipe set <name> [-i/--ingest INGEST] [-p/--pipe STEP …]` — upsert.
  - `-p` is repeatable, one step per flag, `sep:"none"` (a step may contain spaces/commas —
    same convention as today's `srr pipe` and `feed -p`).
  - Validates the pipe via `validatePipe(pipe, allowDefault = name != defaultRecipeName)`:
    `#default` is allowed in any recipe **except** `default`.
  - `-i ""` clears the recipe's ingest (inherit `default` ⇒ `#feed`). Ingest is a free
    string (built-in `#…` or shell command); not otherwise validated, same as today.
- `srr recipe rm <name>` — remove.
  - **Refuses `default`** (the reserved recipe).
  - **Refuses removal while any feed references the recipe** — errors listing the
    referencing feed ids, forcing an explicit re-point first. (No silent dangling refs.)

`filterPipe` and `validatePipe` move from `cmd_pipe.go` to `cmd_recipe.go` (their new home).
After this change `cmd_feeds.go`/`cmd_import.go` no longer call them (feeds carry no inline
pipe — they validate a recipe *name* exists instead); the remaining callers are
`cmd_recipe.go` (`recipe set`) and `cmd_preview.go` (ad-hoc `-p`).

### Removed

- `srr pipe` (`backend/cmd_pipe.go`) — deleted.
- `srr ingest` (`backend/cmd_ingest.go`) — deleted.

### Changed: `srr feed add` / `upd` / `import`

- Replace `-p/--parsers` and `-i/--ingest` with `--recipe NAME` (single string).
  - `feed add --recipe X` / `feed upd ID --recipe X`: set `Feed.Recipe = X`. **Validate X
    exists** in `recipes` (eager failure on a typo). `--recipe ""` clears (⇒ `default`).
  - `feed import --recipe X`: stamp `Recipe = X` on every imported feed
    (`applyImportDefaults`); validate X exists.
- **`feedView`** (`backend/cmd_feeds.go`, the JSON/YAML shape for
  `feed ls/show/apply/edit`): drop `Pipe`/`Ingest`, add `Recipe string `json:"recipe,omitempty"``.
  `feed apply`/`feed edit` accept/emit `recipe`. The empty-string clear convention applies to
  `recipe`.
- **Subscribe-time discovery** (`resolvesFeed` in `cmd_feeds.go`, `resolveImportFeeds` in
  `cmd_import.go`): the `#feed` gate resolves the feed's recipe ingest via
  `ingest.Select(recipe.Ingest, defaultRecipe.Ingest) == ingest.Builtin` instead of reading
  feed/root ingest directly. `importRootIngest` becomes "read the `default` recipe's ingest"
  (or, more directly, resolve each feed's recipe against the loaded recipes map).

### Changed: `srr preview` (`backend/cmd_preview.go`)

- Gains `--recipe NAME` (default `default`): preview a feed URL as if it used that recipe.
- Keeps `-p`/`-i` as **ad-hoc overrides** for experimentation: when given, they override the
  resolved recipe's pipe/ingest (so you can try a pipeline before saving it as a recipe).
- The "root" source for `#default` expansion / empty fallback is the `default` recipe (replacing
  the old `db.core.Pipe`/`db.core.Ingest` reads).

## Frontend / Data Contract

**Recipes are backend-only config**, analogous to `out[]`: the generator emits the types for
contract completeness, but the frontend and service worker do not read the `recipes` map.

- **`cmd_gents.go`**: add `Recipe` to `tsTypes` as `IRecipeWire`, listed **before** `IDBWire`
  (so the generator resolves the nested `DBCore.Recipes map[string]Recipe` type — same
  ordering rule as `IOutFeedWire`). The emitter already maps `map[string]Struct` →
  `Record<string, IRecipeWire>` (`tsType` Map case); no generator-logic change needed beyond
  the `tsTypes` entry.
- **`format.gen.ts`** (generated): `IFeedWire` drops `pipe?`/`ingest?`, gains `recipe?`;
  `IDBWire` drops `pipe?`/`ingest?`, gains `recipes?: Record<string, IRecipeWire>`; new
  `IRecipeWire { ingest?: string; pipe?: string[] }`. Regenerated via `make generate`;
  `make verify` fails if stale.
- **`config.ts` `buildFeedInfo`** (the feed-info dialog "Processing" section): replace the two
  rows — `addRow(proc.dl, "Ingest", ch.ingest || …)` and
  `addRow(proc.dl, "Pipeline", ch.pipe …)` — with a single row:
  ```ts
  addRow(proc.dl, "Recipe", ch.recipe || "default")
  ```
  No client-side recipes-map resolution (the operator inspects a recipe's contents via
  `srr recipe show`). `config.test.ts` updated accordingly (its `feed({… ingest …})` fixture
  becomes `recipe`).
- **`types.d.ts`**: `IFeed`/`IDB` normalizations track the wire change (drop `pipe`/`ingest`
  shape references; `recipes` stays optional — config.ts never indexes it).
- **`sw.ts`**: reads only `gen`/`seq`/`hdrs`/`mp` from db.gz — unaffected.

## Testing

### Backend

- **New** `cmd_recipe_test.go`: `ls`/`show`/`set` (upsert, `#default` allowed for non-default,
  rejected for `default`), `rm` (refuse `default`, refuse referenced recipe), pipe validation.
- **Update** `feed_test.go` (resolution via recipe: `resolvePipe`/`ingest.Select` re-based on
  `default`; `#default` → default pipe), `db_test.go` (NewDB seeds `default` recipe; legacy
  root/feed `pipe`/`ingest` dropped on load), `cmd_feeds_test.go` (`--recipe` flag, validation,
  `feedView` recipe field, subscribe-time gate), `cmd_import_test.go` (`--recipe` stamp +
  gate), preview test (recipe + ad-hoc override), `cmd_gen_test.go` / `cmd_validate_test.go`
  as needed.
- **Remove/repurpose** `cmd_pipe_test.go` and `cmd_ingest_test.go` (commands deleted).

### Frontend

- `config.test.ts`: feed-info "Recipe" row; fixture uses `recipe` not `ingest`.
- Regenerated `format.gen.ts` (contract freshness via `make verify`).

### E2e

- Contract layer (`frontend/e2e/`): feeds written with a non-default recipe round-trip
  (db.gz `recipes` + feed `recipe`). The harness `srr()` calls currently using `feed add -p/-i`
  (if any) switch to `srr recipe set …` + `feed add --recipe …`. (Current `harness.ts`/
  `fixtures.ts` use plain `#feed` defaults, so impact is minimal.)

## Documentation

- Root `CLAUDE.md` Data Contract: rewrite the `pipe`/`ingest` db.gz fields and the
  **Pipe Hierarchy** section as **Recipes** (map of named `{ingest, pipe}`, feed `recipe`
  reference, `default` reserved, `#default` → default).
- `backend/CLAUDE.md`: update the Ingest precedence note, the `cmd_pipe.go`/`cmd_ingest.go`
  entries (now `cmd_recipe.go`), the `cmd_feeds.go`/`cmd_import.go`/`cmd_preview.go`
  descriptions, and the Pipe Hierarchy section.
- `backend/README.md`: any `srr pipe`/`srr ingest`/feed `-p`/`-i` references → recipes.
- The `srr` skill (operator workflow): re-point pipeline/ingest examples at recipes.

## Out of Scope / YAGNI

- No `srr recipe rename`. Re-create + re-point if needed.
- No cross-recipe composition beyond `#default` → `default` (no arbitrary recipe-references-recipe;
  no cycle handling needed because the only expansion target is the `#default`-free `default`).
- No auto-migration of legacy stores (clean break, by decision).
- No frontend client-side recipe resolution (backend-only config; display shows the name).

## Risks / Notes

- **Dangling recipe references**: prevented at write time (CLI validation on `feed --recipe` /
  `recipe set`) and tolerated at read time (`recipeFor` ⇒ `default`). `recipe rm` refuses to
  strand feeds. Net: a hand-edited db.gz with a bad `recipe` still fetches (uses `default`).
- **`#default` self-reference**: only possible by hand-editing `default` to contain `#default`;
  `recipe set default` rejects it (`allowDefault=false`). `resolvePipe` would otherwise expand
  `default` against itself — guarded by the CLI validation, not by runtime cycle detection.
- **Old binary on a new store**: a pre-recipes `srrb` reading a recipes-era db.gz would drop
  the `recipes` map on its next Commit (unknown field) — same single-operator hazard already
  documented for `gen`/`hdrs`/`mp`. Acceptable; the operator runs one binary.
