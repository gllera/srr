# Feed Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SRR's two-axis-two-level processing config (root + per-feed `pipe`/`ingest`) with named `{ingest, pipe}` **recipes** stored once in `db.gz`, referenced by feeds via a `recipe` name.

**Architecture:** Clean break (no auto-migration). `DBCore` and `Feed` drop their `Pipe`/`Ingest` fields. A reserved `default` recipe (seeded `["#sanitize","#minify"]`) is the fallback for every feed and the new home for what root pipe/ingest expressed. Resolution reuses the existing `resolvePipe`/`ingest.Select` helpers unchanged — only the fallback source moves from `DBCore.Pipe`/`Ingest` to the `default` recipe. The `#base` composition token is renamed `#default`. A new `srr recipe` command group manages all recipes (including `default`); `srr pipe`/`srr ingest` are deleted.

**Tech Stack:** Go (backend, `alecthomas/kong` CLI), TypeScript (frontend, Parcel), the `srr gen-ts` reflection generator for the writer↔reader contract.

**Source of truth:** the design spec at `docs/superpowers/specs/2026-06-21-feed-recipes-design.md`. Read it alongside this plan.

---

## Sequencing rationale (read before starting)

This is a clean-break refactor: removing `DBCore.Pipe`/`Ingest` and `Feed.Pipe`/`Ingest` breaks ~10 files at once, so the tree cannot stay green field-by-field. The plan therefore front-loads **additive** work (Tasks 1–2 leave the tree green with both old and new mechanisms present), then performs the irreducible **clean-break switch** as one coordinated task (Task 3) with ordered per-file steps and a single build/test/commit at the end. Tasks 4–8 are green individually.

- **Task 1** — Core recipe model (additive; green).
- **Task 2** — `cmd_recipe.go` command group, wired in alongside the old commands (additive; green).
- **Task 3** — THE SWITCH: remove old fields/commands, rewire fetch/feeds/import/preview, rename `#base`→`#default`, update all backend tests (one big green commit).
- **Task 4** — Regenerate the TS contract (`IRecipeWire`).
- **Task 5** — Frontend feed-info "Recipe" row + test fixture.
- **Task 6** — Documentation.
- **Task 7** — Full `make verify` + e2e contract gate.

Conventions: backend `gofmt`; **wrap every error** `fmt.Errorf("context: %w", err)`; commit after each task. Run backend checks with `make build-be && make test-be` (or `go build ./... && go test ./...` from `backend/`). Run `make verify-be` before the final gate.

---

## Task 1: Core recipe data model (additive)

**Files:**
- Modify: `backend/db.go` (add `Recipe` type, `defaultRecipeName`, `recipeFor`, `db.recipeFor`, seed `default` in `NewDB`; **keep** `DBCore.Pipe`/`Ingest` for now)
- Test: `backend/db_test.go` (add seeding + recipeFor cases)

- [ ] **Step 1: Write the failing tests**

Add to `backend/db_test.go` (package `main`). These use the existing `setupTestDB(t)` helper (confirm its name by reading `db_test.go`/`db_pack_test.go`; it returns a `*DB` against a temp local store). If the helper differs, adapt the open/commit/reopen calls but keep the assertions.

```go
func TestRecipeForFallback(t *testing.T) {
	recipes := map[string]Recipe{
		"default": {Pipe: []string{"#sanitize", "#minify"}},
		"read":    {Pipe: []string{"#readability", "#default"}},
		"tg":      {Ingest: "srr-telegram"}, // pipe omitted ⇒ falls back to default's
	}
	if got := recipeFor(recipes, "read"); !slices.Equal(got.Pipe, []string{"#readability", "#default"}) {
		t.Errorf("recipeFor(read).Pipe = %v", got.Pipe)
	}
	if got := recipeFor(recipes, "tg"); got.Ingest != "srr-telegram" || got.Pipe != nil {
		t.Errorf("recipeFor(tg) = %+v, want {srr-telegram, nil}", got)
	}
	// empty name ⇒ default
	if got := recipeFor(recipes, ""); !slices.Equal(got.Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("recipeFor(\"\") = %v, want default", got.Pipe)
	}
	// unknown name ⇒ default (lenient: a dangling ref never crashes a fetch)
	if got := recipeFor(recipes, "nope"); !slices.Equal(got.Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("recipeFor(nope) = %v, want default", got.Pipe)
	}
}

func TestNewDBSeedsDefaultRecipe(t *testing.T) {
	db := setupTestDB(t) // fresh, empty store
	r, ok := db.core.Recipes[defaultRecipeName]
	if !ok {
		t.Fatalf("fresh DB has no %q recipe", defaultRecipeName)
	}
	if !slices.Equal(r.Pipe, defaultRootPipe()) {
		t.Errorf("default recipe pipe = %v, want %v", r.Pipe, defaultRootPipe())
	}
	if r.Ingest != "" {
		t.Errorf("default recipe ingest = %q, want empty", r.Ingest)
	}
}
```

Ensure `db_test.go` imports `"slices"` (add it if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestRecipeForFallback|TestNewDBSeedsDefaultRecipe' .`
Expected: FAIL — `undefined: Recipe`, `undefined: recipeFor`, `undefined: defaultRecipeName`.

- [ ] **Step 3: Add the `Recipe` type and `defaultRecipeName` const**

In `backend/db.go`, after the `defaultRootPipe` function (ends line ~63), add:

```go
// defaultRecipeName is the reserved recipe every feed falls back to and the
// new home for what the old root pipe/ingest expressed. It always exists
// (NewDB seeds it) and its pipe forbids the #default composition token.
const defaultRecipeName = "default"

// Recipe is a named {ingest, pipe} bundle referenced by feeds (Feed.Recipe).
// An empty field means "inherit the default recipe's value for that axis":
// each axis falls back independently (see recipeFor + Feed.Fetch).
type Recipe struct {
	Ingest string   `json:"ingest,omitempty"`
	Pipe   []string `json:"pipe,omitempty"`
}

// recipeFor resolves a recipe name against the map. An empty or unknown name
// returns the default recipe — lenient, so a dangling reference (hand-edited
// db.gz) never crashes a fetch; the CLI prevents creating dangling refs. A
// plain map (not *DB) so the fetch path can resolve from fetchRun without
// threading the whole DB through Feed.Fetch.
func recipeFor(recipes map[string]Recipe, name string) Recipe {
	if name != "" {
		if r, ok := recipes[name]; ok {
			return r
		}
	}
	return recipes[defaultRecipeName]
}
```

- [ ] **Step 4: Add `Recipes` to `DBCore`**

In `backend/db.go`, in the `DBCore` struct, add the field just above `Feeds` (keep `Pipe`/`Ingest` for now — they are removed in Task 3):

```go
	// Recipes is the map of named {ingest, pipe} bundles feeds reference by
	// name (Feed.Recipe). Always contains the reserved "default" entry (seeded
	// by NewDB). Backend-only config: the frontend/service-worker ignores it,
	// like Out. omitempty is harmless — NewDB re-seeds an absent map.
	Recipes map[string]Recipe `json:"recipes,omitempty"`
```

- [ ] **Step 5: Seed `default` in `NewDB` + add the `db.recipeFor` method**

In `backend/db.go` `NewDB`, the existing block (lines ~217-219) is:

```go
	if db.core.Pipe == nil {
		db.core.Pipe = defaultRootPipe()
	}
```

Leave that block in place for now (removed in Task 3) and add, immediately after it:

```go
	if db.core.Recipes == nil {
		db.core.Recipes = map[string]Recipe{}
	}
	if _, ok := db.core.Recipes[defaultRecipeName]; !ok {
		db.core.Recipes[defaultRecipeName] = Recipe{Pipe: defaultRootPipe()}
	}
```

Then add a method near `Feeds()`/`FeedByID` (anywhere in `db.go`):

```go
// recipeFor resolves a recipe name against this DB's recipes map.
func (o *DB) recipeFor(name string) Recipe {
	return recipeFor(o.core.Recipes, name)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestRecipeForFallback|TestNewDBSeedsDefaultRecipe' .`
Expected: PASS.

- [ ] **Step 7: Full backend build + tests stay green**

Run: `make build-be && make test-be`
Expected: PASS (additive change; nothing removed yet).

- [ ] **Step 8: Commit**

```bash
git add backend/db.go backend/db_test.go
git commit -m "feat(recipes): add Recipe model, recipeFor, default-recipe seeding"
```

---

## Task 2: `srr recipe` command group (additive)

Adds the new command group alongside the still-present `srr pipe`/`srr ingest`. At this point `filterPipe`/`validatePipe` still live in `cmd_pipe.go` (same package), so `cmd_recipe.go` calls them directly; the token is still `#base` (renamed in Task 3).

**Files:**
- Create: `backend/cmd_recipe.go`
- Create: `backend/cmd_recipe_test.go`
- Modify: `backend/main.go` (add `Recipe RecipeGroup` to the `CLI` struct)

- [ ] **Step 1: Write the failing tests**

Create `backend/cmd_recipe_test.go`. Model setup/reopen on `cmd_syndicate_test.go` / `cmd_pipe_test.go` (read one to copy the `globals.Store` temp-dir + `withDB`/reopen pattern; the helper that points `globals.Store` at a temp dir is typically `setupTestDB` or an inline `t.TempDir()` + `globals.Store = …`). Use that established pattern; the assertions below are the contract.

**Important ordering note:** in Task 2 the token is still `#base` (the `#default` rename lands in Task 3) and `Feed.Recipe` does not exist yet. So Task 2's tests must use **only builtin tokens (no `#default`/`#base` composition token)** and must not reference `Feed.Recipe`. The two tests that depend on those (`TestRecipeSetDefaultRejectsDefaultToken`, `TestRecipeRmRefusesReferenced`) are added later, in **Task 3 Step 10**.

```go
package main

import (
	"context"
	"slices"
	"testing"
)

// recipeSet runs `srr recipe set` against the test store.
func recipeSet(t *testing.T, name, ingest string, pipe ...string) error {
	t.Helper()
	cmd := &RecipeSetCmd{Name: name, Ingest: ingest, Pipe: pipe}
	return cmd.Run()
}

func TestRecipeSetUpsertAndShow(t *testing.T) {
	setupRecipeTestStore(t) // points globals.Store at a temp dir (see cmd_pipe_test.go)
	// builtin-only pipe: the #default composition token is not special until Task 3.
	if err := recipeSet(t, "read", "", "#readability", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	err := withDB(false, func(_ context.Context, db *DB) error {
		r := db.core.Recipes["read"]
		if !slices.Equal(r.Pipe, []string{"#readability", "#sanitize"}) {
			t.Errorf("read pipe = %v", r.Pipe)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRecipeSetClearIngest(t *testing.T) {
	setupRecipeTestStore(t)
	_ = recipeSet(t, "tg", "srr-telegram", "#sanitize")
	if err := recipeSet(t, "tg", "", "#sanitize"); err != nil { // -i "" clears
		t.Fatalf("recipe set clear ingest: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if db.core.Recipes["tg"].Ingest != "" {
			t.Errorf("tg ingest = %q, want empty", db.core.Recipes["tg"].Ingest)
		}
		return nil
	})
}

func TestRecipeRmRefusesDefault(t *testing.T) {
	setupRecipeTestStore(t)
	if err := (&RecipeRmCmd{Name: defaultRecipeName}).Run(); err == nil {
		t.Error("recipe rm default accepted, want error")
	}
}
```

Add a `setupRecipeTestStore(t)` helper in this file mirroring the temp-store setup used by `cmd_pipe_test.go` (set `globals.Store = t.TempDir()` and reset any `globals` fields the other tests reset). If an equivalent shared helper already exists (e.g. `setupTestDB` returns a DB but also sets `globals.Store`), reuse it instead and delete this local one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test -run 'TestRecipeSet|TestRecipeRm' .`
Expected: FAIL — `undefined: RecipeSetCmd` / `RecipeRmCmd`.

- [ ] **Step 3: Create `backend/cmd_recipe.go`**

```go
package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// RecipeGroup holds the `srr recipe` sub-commands. Recipes are named
// {ingest, pipe} bundles feeds reference by name; the reserved "default"
// recipe is the fallback for every feed and is edited through the same
// `recipe set` path as any other.
type RecipeGroup struct {
	Ls   RecipeLsCmd   `cmd:"" help:"List all recipes."`
	Show RecipeShowCmd `cmd:"" help:"Print one recipe."`
	Set  RecipeSetCmd  `cmd:"" help:"Add or update a recipe."`
	Rm   RecipeRmCmd   `cmd:"" help:"Remove a recipe (refuses 'default' and recipes still referenced by a feed)."`
}

// RecipeLsCmd prints the whole recipes map as JSON/YAML.
type RecipeLsCmd struct {
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *RecipeLsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		return printFormatted(o.Format, db.core.Recipes)
	})
}

// RecipeShowCmd prints one recipe; errors if it does not exist.
type RecipeShowCmd struct {
	Name   string `arg:"" help:"Recipe name."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *RecipeShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		r, ok := db.core.Recipes[o.Name]
		if !ok {
			return fmt.Errorf("recipe %q not found", o.Name)
		}
		return printFormatted(o.Format, r)
	})
}

// RecipeSetCmd upserts a recipe (full replace, like `srr syndicate set`): the
// stored recipe is exactly {Ingest from -i, Pipe from -p}. Pass both axes to
// set both. -i "" / no -p clear that axis (inherit default).
type RecipeSetCmd struct {
	Name   string   `arg:"" help:"Recipe name. 'default' is the reserved fallback recipe."`
	Ingest string   `short:"i" help:"Ingest strategy: built-in ('#feed') or shell command. Empty inherits the default recipe (⇒ #feed)."`
	Pipe   []string `short:"p" sep:"none" help:"Pipeline step; repeat -p per step (not comma-separated). #default expands to the default recipe's pipe (not allowed in 'default')."`
}

func (o *RecipeSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Name == "" {
			return fmt.Errorf("recipe name is required")
		}
		pipe := filterPipe(o.Pipe)
		// #default is allowed in every recipe except 'default' itself.
		if err := validatePipe(pipe, o.Name != defaultRecipeName); err != nil {
			return err
		}
		if db.core.Recipes == nil {
			db.core.Recipes = map[string]Recipe{}
		}
		db.core.Recipes[o.Name] = Recipe{Ingest: o.Ingest, Pipe: pipe}
		return db.Commit(ctx)
	})
}

// RecipeRmCmd removes a recipe. Refuses to remove 'default', and refuses to
// strand feeds: a recipe still referenced by any feed errors with the
// referencing ids so the operator re-points them first.
type RecipeRmCmd struct {
	Name string `arg:"" help:"Recipe name to remove."`
}

func (o *RecipeRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Name == defaultRecipeName {
			return fmt.Errorf("cannot remove the reserved %q recipe", defaultRecipeName)
		}
		if _, ok := db.core.Recipes[o.Name]; !ok {
			return fmt.Errorf("recipe %q not found", o.Name)
		}
		var refs []int
		for id, ch := range db.Feeds() {
			if ch.Recipe == o.Name {
				refs = append(refs, id)
			}
		}
		if len(refs) > 0 {
			sort.Ints(refs)
			parts := make([]string, len(refs))
			for i, id := range refs {
				parts[i] = fmt.Sprint(id)
			}
			return fmt.Errorf("recipe %q is referenced by feed(s) %s; re-point them first", o.Name, strings.Join(parts, ", "))
		}
		delete(db.core.Recipes, o.Name)
		return db.Commit(ctx)
	})
}
```

> NOTE: `ch.Recipe` references the `Feed.Recipe` field added in Task 3, so the reference-scan loop cannot compile in Task 2. To keep Task 2 building (and avoid an unused-variable error), **omit the loop entirely in Task 2** — write `RecipeRmCmd.Run` with `var refs []int` followed directly by the `if len(refs) > 0 { … }` block (always empty in Task 2), leaving a `// TODO(Task 3): scan db.Feeds() for ch.Recipe == o.Name` comment where the loop will go. Task 3 Step 9 inserts the loop. `refs` is still used by `len(refs)`, so this compiles cleanly. The `TestRecipeRmRefusesReferenced` test is added in Task 3 Step 10.

- [ ] **Step 4: Register the group in `main.go`**

In `backend/main.go`, in the `CLI` struct (lines ~67-80), add after `Syndicate`:

```go
	Recipe    RecipeGroup    `cmd:"" help:"Manage processing recipes (named {ingest, pipe} bundles)."`
```

(Leave `Pipe PipeCmd` and `Ingest IngestCmd` in place — removed in Task 3.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test -run 'TestRecipeSet|TestRecipeRmRefusesDefault' .`
Expected: PASS. (The `#default`-token and feed-reference tests are added in Task 3 Step 10.)

- [ ] **Step 6: Full backend build + tests stay green**

Run: `make build-be && make test-be`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_recipe.go backend/cmd_recipe_test.go backend/main.go
git commit -m "feat(recipes): add srr recipe command group (ls/show/set/rm)"
```

---

## Task 3: THE SWITCH — remove legacy pipe/ingest, rewire everything

This is the irreducible clean break. Apply every edit below in order, then build + test once at the end. The tree will not compile mid-task; that is expected.

**Files (all `backend/`):**
- Modify: `db.go`, `feed.go`, `cmd_fetch.go`, `cmd_recipe.go`, `cmd_feeds.go`, `cmd_import.go`, `cmd_preview.go`, `main.go`
- Delete: `cmd_pipe.go`, `cmd_ingest.go`, `cmd_pipe_test.go`, `cmd_ingest_test.go`
- Modify tests: `feed_test.go`, `cmd_feeds_test.go`, `cmd_import_test.go`, `cmd_validate_test.go`, `cmd_recipe_test.go` (un-defer), `db_test.go` (legacy-drop case)
- Polish (consistency): `mod/main_test.go`, `mod/readability.go`, `mod/selfhost.go`, `mod/main.go` doc comments (`#base`→`#default`)

- [ ] **Step 1: `db.go` — remove legacy root fields + the old default block**

Remove these two lines from `DBCore`:

```go
	Pipe          []string `json:"pipe,omitempty"`
	Ingest        string   `json:"ingest,omitempty"`
```

Remove the now-obsolete seeding block in `NewDB` (the recipe seeding added in Task 1 replaces it):

```go
	if db.core.Pipe == nil {
		db.core.Pipe = defaultRootPipe()
	}
```

`defaultRootPipe()` stays — it seeds the default recipe. The recipe-seeding block from Task 1 remains.

- [ ] **Step 2: `feed.go` — rename token, swap Feed fields, recipe-based fetchRun + Fetch**

(a) Rename the const + comments (lines ~22-42):

```go
// pipeDefault is the token expanded inline to the default recipe's pipe at the
// position where it appears in a recipe's Pipe slice.
const pipeDefault = "#default"

// resolvePipe composes the effective pipeline by expanding "#default"
// tokens in recipePipe to def (the default recipe's pipe). An empty
// recipePipe (nil or []) inherits def; a non-empty recipePipe overrides.
func resolvePipe(def, recipePipe []string) []string {
	if len(recipePipe) == 0 {
		return def
	}
	out := make([]string, 0, len(recipePipe)+len(def))
	for _, m := range recipePipe {
		if m == pipeDefault {
			out = append(out, def...)
		} else {
			out = append(out, m)
		}
	}
	return out
}
```

(b) In the `Feed` struct, remove:

```go
	Pipe    []string `json:"pipe,omitempty"`
	// Ingest is the feed-level extraction strategy. Empty falls through
	// to the db.gz root Ingest → built-in "#feed".
	Ingest   string `json:"ingest,omitempty"`
```

and add (place where `Tag`/`Pipe` were, keeping `Tag`):

```go
	Tag string `json:"tag,omitempty"`
	// Recipe is the name of the {ingest, pipe} recipe this feed uses. Empty
	// resolves to the "default" recipe (recipeFor). A dangling name is tolerated
	// at read time (⇒ default) but the CLI refuses to create one.
	Recipe string `json:"recipe,omitempty"`
```

(Keep the trailing `TotalArt`/`AddIdx`/`newItems` fields.)

(c) In `fetchRun`, replace:

```go
	rootPipe   []string
	rootIngest string
```

with:

```go
	// recipes is the full db.gz recipes map, read-only during a fetch run;
	// each feed resolves its recipe (and the default) from it.
	recipes map[string]Recipe
```

(d) In `Feed.Fetch`, replace:

```go
	pipe := resolvePipe(run.rootPipe, c.Pipe)
```

with:

```go
	r := recipeFor(run.recipes, c.Recipe)
	def := recipeFor(run.recipes, defaultRecipeName)
	pipe := resolvePipe(def.Pipe, r.Pipe)
```

and replace:

```go
	ingestName := ingest.Select(c.Ingest, run.rootIngest)
```

with:

```go
	ingestName := ingest.Select(r.Ingest, def.Ingest)
```

- [ ] **Step 3: `cmd_fetch.go` — populate `run.recipes`**

Replace the `fetchRun` literal fields (lines ~125-126):

```go
				rootPipe:   db.core.Pipe,
				rootIngest: db.core.Ingest,
```

with:

```go
				recipes:    db.core.Recipes,
```

- [ ] **Step 4: Move `filterPipe`/`validatePipe` into `cmd_recipe.go`, delete `cmd_pipe.go`/`cmd_ingest.go`**

Delete the files:

```bash
git rm backend/cmd_pipe.go backend/cmd_ingest.go backend/cmd_pipe_test.go backend/cmd_ingest_test.go
```

Add `filterPipe` + `validatePipe` to `backend/cmd_recipe.go` (renaming `allowBase`→`allowDefault`, `pipeBase`→`pipeDefault`). Add imports `"slices"` and `"srrb/mod"` to `cmd_recipe.go`:

```go
// filterPipe trims each step and drops empty/whitespace-only entries. Returns
// nil when the result is empty so callers can use that as the "clear / inherit
// default" sentinel. Trimming matters: a whitespace-only step would otherwise
// be stored and later run as an empty `/bin/sh -c`, silently breaking a fetch.
func filterPipe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, m := range in {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validatePipe rejects pipeline steps that would silently break a fetch: an
// unknown "#"-prefixed token (a typo'd built-in like "#sanitise"). "#default"
// is valid only in a non-default recipe (allowDefault); the default recipe is
// what it expands to, so it forbids self-reference. Run after filterPipe.
func validatePipe(steps []string, allowDefault bool) error {
	names := mod.Builtins()
	for _, s := range steps {
		fields := strings.Fields(s)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if name == pipeDefault {
			if !allowDefault {
				return fmt.Errorf("%q is not valid inside the %q recipe (it is the default)", pipeDefault, defaultRecipeName)
			}
			continue
		}
		if strings.HasPrefix(name, "#") && !slices.Contains(names, name) {
			return fmt.Errorf("unknown built-in module %q (known: %s)", name, strings.Join(names, ", "))
		}
	}
	return nil
}
```

- [ ] **Step 5: `main.go` — drop the old command fields**

In the `CLI` struct, remove:

```go
	Pipe      PipeCmd        `cmd:"" help:"Set or print root pipe (default pipeline inherited by feeds)."`
	Ingest    IngestCmd      `cmd:"" help:"Set or print root ingest strategy (default inherited by feeds)."`
```

(`Recipe RecipeGroup` from Task 2 remains.)

- [ ] **Step 6: `cmd_feeds.go` — feedView, flags, normalizeFeed, writeFeedView, viewOf, resolvesFeed**

(a) `feedView` struct — replace `Pipe`/`Ingest` with `Recipe`:

```go
type feedView struct {
	ID     *int   `json:"id,omitempty" yaml:"id,omitempty"`
	Title  string `json:"title"        yaml:"title"`
	URL    string `json:"url"          yaml:"url"`
	Error  string `json:"error,omitempty" yaml:"error,omitempty"`
	Tag    string `json:"tag,omitempty" yaml:"tag,omitempty"`
	Recipe string `json:"recipe,omitempty" yaml:"recipe,omitempty"`
}
```

(b) `viewOf` — replace the `Pipe`/`Ingest` lines with:

```go
		Recipe: ch.Recipe,
```

(remove the `Pipe: append(...)` and `Ingest: ch.Ingest` lines).

(c) `resolvesFeed` — change signature to resolve via recipes:

```go
// resolvesFeed reports whether subscribe-time discovery applies: only when the
// feed's effective ingest strategy (its recipe's, falling back to default's)
// is the built-in #feed. External ingest strategies own their own source and
// are stored as-is.
func resolvesFeed(recipes map[string]Recipe, recipeName string) bool {
	r := recipeFor(recipes, recipeName)
	def := recipeFor(recipes, defaultRecipeName)
	return ingest.Select(r.Ingest, def.Ingest) == ingest.Builtin
}
```

(d) `normalizeFeed` — validate the recipe name exists instead of pipe; needs the recipes map:

```go
// normalizeFeed validates a feed just before it is persisted (the single
// chokepoint for add/upd/apply/edit/import): its recipe reference must exist
// (no dangling refs created via the CLI) and its tag must be OPML-safe.
func normalizeFeed(ch *Feed, recipes map[string]Recipe) error {
	if err := validateRecipeRef(recipes, ch.Recipe); err != nil {
		return err
	}
	return validateTag(ch.Tag)
}

// validateRecipeRef accepts an empty name (⇒ default) or any existing recipe;
// a non-empty unknown name is an eager error listing the available recipes.
func validateRecipeRef(recipes map[string]Recipe, name string) error {
	if name == "" {
		return nil
	}
	if _, ok := recipes[name]; ok {
		return nil
	}
	avail := make([]string, 0, len(recipes))
	for n := range recipes {
		avail = append(avail, n)
	}
	sort.Strings(avail)
	return fmt.Errorf("recipe %q does not exist (available: %s)", name, strings.Join(avail, ", "))
}
```

Update the doc comment above `normalizeFeed` accordingly (drop the `#base` mention).

(e) `AddCmd` — replace `Parsers`/`Ingest` flags with `Recipe`:

```go
type AddCmd struct {
	Title  *string `short:"t" required:"" help:"Feed title."`
	URL    *string `short:"u" required:"" help:"Feed RSS url."`
	Tag    *string `short:"g" optional:"" help:"Feed tag."`
	Recipe *string `short:"r" optional:"" help:"Recipe name (must exist). Empty inherits 'default'."`
}
```

In `AddCmd.Run`, replace the `feedView` construction + resolvesFeed call:

```go
	v := &feedView{
		Title: *o.Title,
		URL:   *o.URL,
	}
	if o.Tag != nil {
		v.Tag = *o.Tag
	}
	if o.Recipe != nil {
		v.Recipe = *o.Recipe
	}
	return withDB(true, func(ctx context.Context, db *DB) error {
		if resolvesFeed(db.core.Recipes, v.Recipe) {
			resolved, err := resolveFeedURL(ctx, v.URL)
			if err != nil {
				return fmt.Errorf("resolve feed %q: %w", v.URL, err)
			}
			v.URL = resolved
		}
		return applyViews(ctx, db, []*feedView{v})
	})
```

(f) `UpdCmd` — replace `Parsers`/`Ingest` with `Recipe`:

```go
type UpdCmd struct {
	ID     int     `arg:""                help:"Feed id to update."`
	Title  *string `short:"t" optional:"" help:"Feed title (empty rejected)."`
	URL    *string `short:"u" optional:"" help:"Feed RSS url. Changing it resets the feed's fetch state (etag/watermark/dedup)."`
	Tag    *string `short:"g" optional:"" help:"Feed tag. Empty (\"\") to clear."`
	Recipe *string `short:"r" optional:"" help:"Recipe name (must exist). Empty (\"\") to clear (⇒ default)."`
}
```

In `UpdCmd.Run`: change the nothing-to-update guard and the field updates:

```go
	if o.Title == nil && o.Tag == nil && o.Recipe == nil && o.URL == nil {
		return fmt.Errorf("nothing to update")
	}
```

Replace the `if o.Parsers != nil { ch.Pipe = … }` and `if o.Ingest != nil { ch.Ingest = … }` blocks with:

```go
		if o.Recipe != nil {
			ch.Recipe = *o.Recipe
		}
```

In the URL-repoint branch, replace `resolvesFeed(ch.Ingest, db.core.Ingest)` with `resolvesFeed(db.core.Recipes, ch.Recipe)`.

Replace the final `normalizeFeed(ch)` call with `normalizeFeed(ch, db.core.Recipes)`.

(g) `writeFeedView` — replace the `Pipe`/`Ingest` assignments:

```go
func writeFeedView(ch *Feed, v *feedView) {
	ch.Title = v.Title
	setFeedURL(ch, v.URL)
	ch.Tag = v.Tag
	ch.Recipe = v.Recipe
}
```

(h) `applyViews` — its `normalizeFeed(target)` call becomes `normalizeFeed(target, db.core.Recipes)`.

- [ ] **Step 7: `cmd_import.go` — flags, defaults, gate**

(a) `ImportCmd` — replace `Parsers`/`Ingest` with `Recipe`:

```go
type ImportCmd struct {
	Path   string   `arg:""                help:"Feeds opml file."`
	ID     []string `short:"i"             help:"Ids to import."`
	All    bool     `short:"a"             help:"Import all."`
	Tag    *string  `short:"g"             help:"Tag to assign to imported feeds. Overrides OPML group tags."`
	DryRun bool     `short:"n"             help:"Dry run. List resulting feeds without importing."`
	Recipe *string  `short:"r" optional:"" help:"Recipe name applied to every imported feed (must exist). Empty (\"\") clears (⇒ default)."`
}
```

(b) In `ImportCmd.Run`, replace the `applyImportDefaults(...)` + `importRootIngest()` + `resolveImportFeeds(...)` block:

```go
	applyImportDefaults(newFeeds, o.Recipe, o.Tag)

	// Subscribe-time discovery gate reads the recipes map (read-only).
	recipes, err := importRecipes()
	if err != nil {
		return err
	}
	kept, failed := resolveImportFeeds(context.Background(), newFeeds, recipes)
	reportImportFailures(failed)
```

(c) In the final `withDB` apply loop, change `normalizeFeed(c)` to `normalizeFeed(c, db.core.Recipes)`.

(d) Rewrite `applyImportDefaults`:

```go
// applyImportDefaults stamps Recipe / Tag onto every imported feed. recipe and
// tag pointers are nil when the corresponding CLI flag is absent.
func applyImportDefaults(feeds []*Feed, recipe, tag *string) {
	if recipe != nil {
		for _, c := range feeds {
			c.Recipe = *recipe
		}
	}
	if tag != nil {
		for _, c := range feeds {
			c.Tag = *tag
		}
	}
}
```

(e) Rewrite `resolveImportFeeds` to gate on recipes:

```go
func resolveImportFeeds(ctx context.Context, feeds []*Feed, recipes map[string]Recipe) (kept []*Feed, failed []importFailure) {
	resolved := make([]string, len(feeds))
	errs := make([]error, len(feeds))

	sem := make(chan struct{}, max(1, globals.Workers))
	var wg sync.WaitGroup
	for i, c := range feeds {
		if !resolvesFeed(recipes, c.Recipe) {
			resolved[i] = c.URL // external ingest: stored as-is, never probed
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, url string) {
			defer wg.Done()
			defer func() { <-sem }()
			resolved[i], errs[i] = resolveFeedURL(ctx, url)
		}(i, c.URL)
	}
	wg.Wait()

	for i, c := range feeds {
		if errs[i] != nil {
			failed = append(failed, importFailure{Title: c.Title, URL: c.URL, Err: errs[i]})
			continue
		}
		c.URL = resolved[i]
		kept = append(kept, c)
	}
	return kept, failed
}
```

(f) Replace `importRootIngest` with `importRecipes`:

```go
// importRecipes reads the db.gz recipes map (read-only, unlocked) so
// resolveImportFeeds can resolve each feed's recipe to gate #feed discovery.
func importRecipes() (map[string]Recipe, error) {
	var recipes map[string]Recipe
	err := withDB(false, func(_ context.Context, db *DB) error {
		recipes = db.core.Recipes
		return nil
	})
	return recipes, err
}
```

- [ ] **Step 8: `cmd_preview.go` — `--recipe` + ad-hoc `-p`/`-i` overrides**

(a) Add the `Recipe` flag to `PreviewCmd` (keep `Pipe`/`Ingest` as ad-hoc overrides):

```go
type PreviewCmd struct {
	URL    *url.URL `arg:"" help:"URL to preview."`
	Recipe string   `short:"r" default:"default" help:"Preview as if the feed used this recipe."`
	Pipe   []string `short:"p" sep:"none" help:"Ad-hoc pipeline override (repeat -p per step); overrides the recipe's pipe. #default expands to the default recipe's pipe."`
	Ingest string   `short:"i" help:"Ad-hoc ingest override: built-in ('#feed') or shell command. Overrides the recipe's ingest."`
	Addr   string   `short:"a" default:"localhost:8080" env:"SRR_PREVIEW_ADDR" help:"Address to listen on."`
}
```

(b) Replace the db-read + resolution block (lines ~67-92). Read the recipes map, resolve the chosen recipe against the default, and apply ad-hoc overrides:

```go
	var recipes map[string]Recipe
	if err := withDB(false, func(_ context.Context, db *DB) error {
		recipes = db.core.Recipes
		return nil
	}); err != nil {
		return err
	}

	ctx := context.Background()
	client := &http.Client{Timeout: 10 * time.Second}
	processor := mod.New()
	engine := ingest.New()

	r := recipeFor(recipes, o.Recipe)
	def := recipeFor(recipes, defaultRecipeName)
	// Effective pipeline: the recipe's pipe over the default; an ad-hoc -p
	// overrides the recipe's pipe (still expanding #default), so you can try a
	// pipeline before saving it as a recipe.
	chPipe := r.Pipe
	if len(o.Pipe) > 0 {
		chPipe = o.Pipe
	}
	pipe := resolvePipe(def.Pipe, chPipe)
	if err := processor.Validate(ctx, pipe); err != nil {
		return fmt.Errorf("invalid pipeline %v: %w", pipe, err)
	}

	buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
	name := ingest.Select(r.Ingest, def.Ingest)
	if o.Ingest != "" {
		name = o.Ingest
	}
```

(The rest of `PreviewCmd.Run` — the fetch, item loop, server — is unchanged.)

- [ ] **Step 9: `cmd_recipe.go` — un-stub the `Feed.Recipe` reference**

Restore the `RecipeRmCmd.Run` line stubbed in Task 2:

```go
		for id, ch := range db.Feeds() {
			if ch.Recipe == o.Name {
				refs = append(refs, id)
			}
		}
```

- [ ] **Step 10: Update tests — recipe ref test, feed/import/validate/db tests, remove pipe/ingest tests**

(a) `cmd_recipe_test.go`: add the two tests deferred from Task 2 (they depend on the `#default` token rename and `Feed.Recipe`, both now present):

```go
func TestRecipeSetDefaultRejectsDefaultToken(t *testing.T) {
	setupRecipeTestStore(t)
	// #default is forbidden inside the default recipe (it IS the default).
	if err := recipeSet(t, defaultRecipeName, "", "#default", "#minify"); err == nil {
		t.Error("recipe set default with #default accepted, want error")
	}
	// but allowed in any other recipe
	if err := recipeSet(t, "x", "", "#default"); err != nil {
		t.Errorf("recipe set x with #default rejected: %v", err)
	}
}

func TestRecipeRmRefusesReferenced(t *testing.T) {
	setupRecipeTestStore(t)
	_ = recipeSet(t, "read", "", "#readability", "#default")
	_ = withDB(true, func(ctx context.Context, db *DB) error {
		if err := db.AddFeed(&Feed{Title: "T", URL: "http://example.com/rss", Recipe: "read"}); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
	if err := (&RecipeRmCmd{Name: "read"}).Run(); err == nil {
		t.Error("recipe rm of a referenced recipe accepted, want error listing feed ids")
	}
}
```

(b) `feed_test.go`: the helpers call `fetchURL` directly with `ch.Pipe`/`ingest.Select(ch.Ingest, …)`, which no longer exist. Change them to pass an explicit pipeline + ingest name. Replace `fetchOnce`'s `fetchURL` call:

```go
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, ingest.Select("", ""))
```

Replace `dispatchStub` to take an explicit ingest name:

```go
func dispatchStub(t *testing.T, ch *Feed, ingestName string) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	const fetchedAt int64 = 4_102_444_800
	run := &fetchRun{engine: ingest.New(), fetchedAt: fetchedAt}
	items, err := ch.fetchURL(context.Background(), run, buf, mod.New(), nil, ingestName)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}
```

Update its callers: `TestFetchInheritsIngestFromFeed` (and any sibling) that built `ch := &Feed{… Ingest: "#test-stub"}` + `dispatchStub(t, ch, "")` become `ch := &Feed{Title: "T", URL: "irrelevant://value"}` + `dispatchStub(t, ch, "#test-stub")`. (Grep `dispatchStub(` and `Ingest:` / `Pipe:` in `feed_test.go` and fix each — there is the one shown plus any others the grep surfaces.) Also fix the third `fetchURL` call near line 356 the same way as `fetchOnce`.

(c) `cmd_feeds_test.go`: the assertions on `ch.Pipe` / `Feeds()[0].Ingest` (lines ~406-444) and any `AddCmd{Parsers:…, Ingest:…}` / `UpdCmd{Parsers:…, Ingest:…}` literals must move to the recipe model. Rewrite those subtests to:
   - set up a recipe first (`recipeSet(t, "read", "", "#readability", "#default")` or use a `RecipeSetCmd`),
   - `AddCmd{… Recipe: ptr("read")}` / `UpdCmd{… Recipe: ptr("read")}`,
   - assert `reopenDB(t).Feeds()[id].Recipe == "read"`, and that adding with a **nonexistent** recipe errors (eager validation).
   Use the file's existing `ptr`/string-pointer helper (grep for how `Title`/`Ingest` pointers were built).

(d) `cmd_import_test.go`: the `applyImportDefaults` call (line ~400) now takes `(feeds, recipe, tag)` — drop the parsers arg. The `feeds[0].Pipe`/`.Ingest` assertions (lines ~313-406) become `feeds[0].Recipe` assertions. Rewrite the "stamp" subtest to assert `applyImportDefaults(feeds, ptr("read"), nil)` sets `feeds[0].Recipe == "read"`, and drop the pipe-specific cases (filterPipe no longer applies to feeds).

(e) `cmd_validate_test.go`: `validatePipe(steps, allowBase)` → `validatePipe(steps, allowDefault)` and `#base` → `#default`:

```go
	// default recipe: #default disallowed; unknown #-token disallowed; built-ins/shell ok.
	if err := validatePipe([]string{"#sanitize", "#minify", "jq ."}, false); err != nil {
		t.Errorf("valid default pipe rejected: %v", err)
	}
	if err := validatePipe([]string{"#default"}, false); err == nil {
		t.Error("default recipe accepted #default, want error")
	}
	if err := validatePipe([]string{"#sanitise"}, false); err == nil {
		t.Error("accepted typo'd #sanitise, want error")
	}
	// non-default recipe: #default allowed.
	if err := validatePipe([]string{"#readability", "#default"}, true); err != nil {
		t.Errorf("non-default recipe with #default rejected: %v", err)
	}
```

(f) `db_test.go`: add a legacy-drop test proving an old db.gz's root/feed `pipe`/`ingest` keys are dropped and every feed resolves to `default`:

```go
func TestNewDBDropsLegacyPipeIngest(t *testing.T) {
	// Write a legacy db.gz by hand (old root pipe/ingest + a feed with inline
	// pipe/ingest) into a temp store, then open it with NewDB.
	dir := t.TempDir()
	globals.Store = dir
	legacy := `{"fetched_at":0,"total_art":0,"next_pid":0,"pack_off":0,` +
		`"pipe":["#readability"],"ingest":"old-ingest",` +
		`"feeds":{"0":{"title":"T","url":"http://example.com/rss","pipe":["#minify"],"ingest":"x"}}}`
	writeLegacyDB(t, dir, legacy) // gzip `legacy` to <dir>/db.gz (see helper note)

	db, err := NewDB(context.Background(), false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db.Close(context.Background())

	if db.core.Recipes[defaultRecipeName].Ingest != "" ||
		!slices.Equal(db.core.Recipes[defaultRecipeName].Pipe, defaultRootPipe()) {
		t.Errorf("default recipe not seeded fresh; got %+v", db.core.Recipes[defaultRecipeName])
	}
	if db.core.Feeds[0].Recipe != "" {
		t.Errorf("legacy feed Recipe = %q, want empty (⇒ default)", db.core.Feeds[0].Recipe)
	}
}
```

Add a `writeLegacyDB(t, dir, json)` helper that gzip-compresses `json` to `filepath.Join(dir, "db.gz")` (mirror `db.Commit`'s gzip path — `gzip.NewWriter` over a file). If `db_test.go` already has a raw-db-write helper, reuse it.

(g) Confirm `cmd_pipe_test.go` / `cmd_ingest_test.go` were deleted in Step 4.

- [ ] **Step 11: Polish — rename `#base`→`#default` in `mod/` doc text + test**

These are cosmetic (the `mod` package treats any unknown `#`-token as invalid regardless), but keep the codebase consistent with the rename:
- `mod/main_test.go:358` — change the `{"#base"}` "leftover is invalid" case to `{"#default"}`.
- `mod/main.go:259`, `mod/readability.go:19`, `mod/selfhost.go:24` — update the `#base` mentions in doc comments to `#default` (and adjust example pipes like `["#base", "#selfhost"]` → `["#default", "#selfhost"]`).

- [ ] **Step 12: Build, format, test**

Run:
```bash
cd backend && gofmt -w . && go build ./... && go test ./...
```
Expected: PASS. If a stray `core.Pipe`/`core.Ingest`/`.Pipe`/`.Ingest`/`rootPipe`/`rootIngest`/`pipeBase`/`allowBase`/`importRootIngest` reference remains, the compiler names the file+line — fix and re-run. Sweep to confirm none survive:
```bash
grep -rn "core\.Pipe\|core\.Ingest\|rootPipe\|rootIngest\|pipeBase\|allowBase\|importRootIngest\|\.Parsers" --include="*.go" backend/
```
Expected: no matches (the only `Pipe`/`Ingest` left are `PreviewCmd.Pipe`/`.Ingest` ad-hoc flags, `os.Pipe`/`io.Pipe` in unrelated tests, and `RecipeSetCmd`/`recipeFor` internals).

- [ ] **Step 13: Commit**

```bash
git add -A backend/
git commit -m "feat(recipes): clean-break switch — remove root/feed pipe+ingest, rewire to recipes"
```

---

## Task 4: Regenerate the TS contract

**Files:**
- Modify: `backend/cmd_gents.go` (add `IRecipeWire` to `tsTypes`)
- Modify (generated): `frontend/src/js/format.gen.ts` (via `make generate`)

- [ ] **Step 1: Add `Recipe` to `tsTypes`**

In `backend/cmd_gents.go`, in the `tsTypes` slice, add an entry **before** `IDBWire` (so the generator resolves the nested `DBCore.Recipes map[string]Recipe`), mirroring the `IOutFeedWire` ordering:

```go
	{"IOutFeedWire", "a db.gz out[] entry (backend OutFeed)", reflect.TypeOf(OutFeed{})},
	// IRecipeWire is backend-only config; the frontend/service-worker ignores it.
	{"IRecipeWire", "a db.gz recipes{} value (backend Recipe)", reflect.TypeOf(Recipe{})},
	{"IDBWire", "db.gz itself (backend DBCore)", reflect.TypeOf(DBCore{})},
```

- [ ] **Step 2: Regenerate**

Run: `make generate`
Then inspect: `git diff frontend/src/js/format.gen.ts`
Expected: `IFeedWire` drops `pipe?`/`ingest?` and gains `recipe?: string`; a new `IRecipeWire { ingest?: string; pipe?: string[] }` appears before `IDBWire`; `IDBWire` drops `pipe?`/`ingest?` and gains `recipes?: Record<string, IRecipeWire>`.

- [ ] **Step 3: Freshness gate passes**

Run: `cd backend && go run . gen-ts --check` (or `make generate-check`)
Expected: exit 0 (no drift).

- [ ] **Step 4: Commit**

```bash
git add backend/cmd_gents.go frontend/src/js/format.gen.ts
git commit -m "feat(recipes): emit IRecipeWire; regenerate format.gen.ts"
```

---

## Task 5: Frontend feed-info "Recipe" row

**Files:**
- Modify: `frontend/src/js/config.ts:488-491` (the "Processing" section of `buildFeedInfo`)
- Modify: `frontend/src/js/config.test.ts:270` (fixture uses `recipe`, not `ingest`)
- Verify only: `frontend/src/js/types.d.ts` (no edit needed — `IFeed extends IFeedWire`, which now carries `recipe?`; `recipes` lives on `IDB` via `IDBWire`, never indexed client-side)

- [ ] **Step 1: Update the failing fixture first**

In `frontend/src/js/config.test.ts` line ~270, the feed fixture passes `ingest: "#feed"`, which is no longer a valid `IFeedWire` key (TS excess-property error after regen). Change it to a recipe reference (or drop the field — it's only there as a feed-shape fixture for the filter picker):

```ts
         untagged: [feed({ id: 5, title: "Feed5", url: "http://example.com/rss", recipe: "default", total_art: 12 })],
```

- [ ] **Step 2: Run the frontend type-check/test to see the failure**

Run: `cd frontend && npx tsc --noEmit` (or `make verify-fe` for the full pipeline)
Expected: BEFORE the config.ts edit, a type error on `ch.ingest`/`ch.pipe` in `config.ts` (those keys no longer exist on `IFeed`).

- [ ] **Step 3: Replace the Processing rows in `config.ts`**

Replace lines ~488-491:

```ts
   const proc = infoSection("Processing")
   addRow(proc.dl, "Ingest", ch.ingest || "Default (#feed)")
   addRow(proc.dl, "Pipeline", ch.pipe && ch.pipe.length ? ch.pipe.join("  →  ") : "Inherited from default")
   frag.appendChild(proc.sec)
```

with a single Recipe row (the operator inspects a recipe's contents via `srr recipe show`; no client-side recipes-map resolution):

```ts
   const proc = infoSection("Processing")
   addRow(proc.dl, "Recipe", ch.recipe || "default")
   frag.appendChild(proc.sec)
```

- [ ] **Step 4: Frontend pipeline passes**

Run: `make verify-fe`
Expected: PASS (lint + prettier + tsc + tests + build).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/config.ts frontend/src/js/config.test.ts
git commit -m "feat(recipes): feed-info shows Recipe row; update fixture"
```

---

## Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` (root — Data Contract `pipe`/`ingest` fields + Pipe Hierarchy section → Recipes)
- Modify: `backend/CLAUDE.md` (Ingest precedence note; `cmd_pipe.go`/`cmd_ingest.go` entries → `cmd_recipe.go`; `cmd_feeds.go`/`cmd_import.go`/`cmd_preview.go` descriptions; Pipe Hierarchy section)
- Modify: `backend/README.md` (replace `srr pipe`/`srr ingest`/feed `-p`/`-i` examples with recipes)
- Modify: the `srr` skill at `/home/gllera/.config/claude/skills/srr/SKILL.md` (re-point pipeline/ingest examples at recipes — only if it references them; grep first)

- [ ] **Step 1: Root `CLAUDE.md`**

In the `db.gz` field table: remove the `pipe` and `ingest` rows; add a `recipes` row:

```
| `recipes` | object | Map of named `{ingest, pipe}` bundles (`Record<string, Recipe>`). Always contains a reserved `default` entry (seeded `["#sanitize","#minify"]`), the fallback for every feed and the home for what root pipe/ingest expressed. Feeds reference one by `recipe` name. Backend-only config: the frontend/service-worker ignores it (like `out`). `omitempty`; `NewDB` re-seeds `default` if absent. Managed via `srr recipe`. |
```

In the **Feeds (`IFeed`)** section: change the field list `… pipe?:string[], ingest?, tag? }` to `… tag?, recipe? }` and update the prose: a feed carries `recipe` (a name into `recipes`); empty ⇒ `default`.

Rewrite the **Pipe Hierarchy** section as **Recipes**:

```
### Recipes

Processing config lives in named `{ingest, pipe}` recipes in db.gz (`recipes` map),
referenced by feeds via the `recipe` field. The reserved `default` recipe (always
present, seeded `["#sanitize","#minify"]`) is the fallback.

- A feed with empty/absent `recipe` resolves to `default`.
- Each axis falls back to `default` independently: a recipe that sets only `ingest`
  uses its own ingest and `default`'s pipe; only `pipe` ⇒ its pipe and `default`'s ingest.
- `#default` inside a recipe's pipe expands inline to the `default` recipe's pipe;
  the `default` recipe forbids `#default` (it is the default).
- Built-in mods use `#` (`#sanitize`, `#minify`, `#readability`, `#filter`, `#selfhost`);
  anything else is a shell command. Ingest: built-in `#feed`, or a shell command.
- Resolution: `pipe = resolvePipe(default.Pipe, recipe.Pipe)`,
  `ingest = ingest.Select(recipe.Ingest, default.Ingest)`.
- Managed via `srr recipe set/ls/show/rm`. Clean break: a pre-recipes db.gz drops its
  legacy root/feed `pipe`/`ingest` on load and every feed reverts to `default`.
```

- [ ] **Step 2: `backend/CLAUDE.md`**

- `main.go` command-groups line: drop `pipe`; drop `ingest`; add `recipe`.
- Replace the `cmd_pipe.go` and `cmd_ingest.go` bullet entries with a `cmd_recipe.go` entry describing `RecipeGroup` (ls/show/set/rm), the `default` reserved recipe, `#default` validation (`allowDefault = name != "default"`), `rm` refusing `default`/referenced recipes, and that `filterPipe`/`validatePipe` now live here.
- Update the `cmd_feeds.go` entry: `feedView` is `{id?, title, url, error?, tag?, recipe?}`; `-r/--recipe` replaces `-p`/`-i`; `normalizeFeed` validates the recipe name exists.
- Update the `cmd_import.go` entry: `-r/--recipe` stamp; `importRecipes` (was `importRootIngest`); gate via the recipe's resolved ingest.
- Update the `cmd_preview.go` entry: `--recipe` (default `default`) + ad-hoc `-p`/`-i` overrides.
- `feed.go` entry: `Feed` carries `Recipe` (not `Pipe`/`Ingest`); `fetchRun` carries `recipes`; `resolvePipe`/`#default` (was `#base`); `Feed.Fetch` resolves the recipe + default.
- `db.go` entry: add `Recipe` type, `recipeFor`/`db.recipeFor`, `defaultRecipeName`, `NewDB` seeds `default`.
- Rewrite the **Pipe Hierarchy** section (bottom) to **Recipes**, mirroring the root CLAUDE.md text, and update the CLI examples (`srr recipe set …`, `srr feed add -r …`).

- [ ] **Step 3: `backend/README.md`**

Replace every `srr pipe`/`srr ingest`/feed `-p`/`-i` reference (lines ~60, 66, 69-75, 96, 189, 199-203, 349, 409, 430-444) with the recipe model: `srr recipe set <name> -i <ingest> -p <step> …`, `srr feed add -r <name>`, `srr preview <url> -r <name>` (and `-p`/`-i` as ad-hoc overrides), `#default` instead of `#base`, and the `default`-recipe explanation in place of the "Root default" paragraph.

- [ ] **Step 4: `srr` skill (conditional)**

Run: `grep -n "srr pipe\|srr ingest\|-p \|-i " /home/gllera/.config/claude/skills/srr/SKILL.md`
If any pipeline/ingest examples exist, re-point them at `srr recipe`. If none, skip.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md backend/CLAUDE.md backend/README.md
git commit -m "docs(recipes): rewrite pipe/ingest docs as recipes"
```

(Add the skill file to the commit only if edited; it lives outside the repo at `~/.config/claude/skills/srr/SKILL.md` — commit it separately/skip from the repo commit.)

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full project verify**

Run: `make verify`
Expected: PASS — `verify-fe` + `verify-be` (vet, gofmt check, build, tests, `generate-check`) + the e2e contract layer.

- [ ] **Step 2: Spot-check the CLI end-to-end against a scratch store**

```bash
TMP=$(mktemp -d)
SRR_STORE=$TMP ./backend/srr recipe ls            # shows {"default":{"pipe":["#sanitize","#minify"]}}
SRR_STORE=$TMP ./backend/srr recipe set read -p "#readability" -p "#default"
SRR_STORE=$TMP ./backend/srr feed add -t Blog -u http://example.com/rss -r read   # may network-probe; use a real feed or expect a resolve error
SRR_STORE=$TMP ./backend/srr feed add -t Bad -u http://example.com/rss -r nope    # MUST error: recipe "nope" does not exist
SRR_STORE=$TMP ./backend/srr recipe rm default                                    # MUST error: cannot remove reserved
```
(Build the binary first if needed: `make build-be` then use `dist/srrb`. Adjust the binary path to wherever the build emits it.)
Expected: `recipe ls` shows the seeded `default`; the bad-recipe `feed add` errors eagerly; `recipe rm default` is refused.

- [ ] **Step 3: Final commit (if any verify-driven fixes)**

```bash
git add -A
git commit -m "test(recipes): verify gate green end-to-end"
```

---

## Self-Review (completed during planning)

**Spec coverage** — every spec section maps to a task:
- Decisions 1 (reserved `default`, root fields gone) → Tasks 1, 3. Decision 2 (clean-break migration) → Task 3 Step 1 + db_test legacy-drop. Decision 3 (`#default` rename, `allowBase`→`allowDefault`) → Task 3 Steps 2,4,10e,11. Decision 4 (naming `recipes`/`recipe`/`srr recipe`) → Tasks 1,2,3. Decision 5 (`srr pipe`/`ingest` removed) → Task 3 Steps 4,5.
- Data Model (`Recipe`, `DBCore.Recipes`, `Feed.Recipe`, `defaultRecipeName`) → Tasks 1, 3. Wire shape → Tasks 1, 4.
- Resolution Semantics (`recipeFor`, independent axis fallback, `resolvePipe`/`ingest.Select` unchanged, fetchRun.recipes) → Tasks 1, 3 Steps 2,3.
- NewDB seeding → Task 1 Step 5.
- CLI (`srr recipe` group; removed `pipe`/`ingest`; `feed add/upd/import --recipe` + validation; `feedView`; subscribe-time gate; `preview --recipe` + ad-hoc) → Tasks 2, 3 Steps 6,7,8.
- Frontend/Contract (`cmd_gents.go` `IRecipeWire`, `format.gen.ts`, `config.ts` Recipe row, `config.test.ts`, `types.d.ts`) → Tasks 4, 5.
- Testing (new `cmd_recipe_test.go`; updated feed/db/feeds/import/validate/preview tests; removed pipe/ingest tests; frontend config test; e2e) → Tasks 2, 3 Step 10, 5, 7.
- Documentation → Task 6.
- Risks (dangling refs prevented at write + tolerated at read; `#default` self-ref guarded by CLI) → covered by `recipeFor` leniency (Task 1) + `validateRecipeRef`/`recipe rm` refusal (Tasks 2, 3) + `validatePipe(allowDefault=false)` for `default` (Tasks 2, 3).

**Type consistency** — names used consistently across tasks: `Recipe{Ingest,Pipe}`, `recipeFor(map, name) Recipe`, `db.recipeFor`, `defaultRecipeName="default"`, `pipeDefault="#default"`, `validatePipe(steps, allowDefault)`, `resolvesFeed(recipes, recipeName)`, `normalizeFeed(ch, recipes)`, `validateRecipeRef(recipes, name)`, `importRecipes()`, `fetchRun.recipes`, `feedView.Recipe`, `Feed.Recipe`, flags `-r/--recipe`. The `preview` ad-hoc flags stay `Pipe`/`Ingest`; the recipe set flags are `Ingest string`/`Pipe []string` (full-replace, like `srr syndicate set`).

**Known intra-task non-compiling windows** (documented inline, resolved within the same task): Task 2's `cmd_recipe.go`/`cmd_recipe_test.go` reference `Feed.Recipe` (added in Task 3) — stubbed with `// TODO(Task 3)` and restored in Task 3 Steps 9–10. Task 3 is intentionally one large green commit (clean-break compile coupling).
