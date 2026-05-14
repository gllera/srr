# OPML Import — Merge & Channel-Level Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `srr chan import` so an operator can (1) merge a selection of OPML outlines into a single channel with multiple feeds via `-t/--title`, and (2) stamp every imported channel with channel-level `Pipe` (`-p`) and `Ingest` (`--ingest`).

**Architecture:** Pure Go work in `backend/cmd_import.go`. A small `applyImportDefaults` helper centralises Tag / Pipe / Ingest stamping over the channels emitted by the walker. Merge mode is a flag on the existing `importWalker`: when set, selected nodes append `*Feed`s to an accumulator instead of producing per-node `*Channel`s; `Run` assembles the single merged channel after the walk.

**Tech Stack:** Go, `alecthomas/kong` (CLI). Tests are stdlib `testing`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-14-opml-import-merge-design.md](docs/superpowers/specs/2026-05-14-opml-import-merge-design.md)

---

## File Map

| File | Action |
|---|---|
| [backend/cmd_import.go](backend/cmd_import.go) | Modify: add `Title *string`, `Parsers *[]string`, `Ingest *string` fields to `ImportCmd`; add validation in `Run`; add `merge`/`mergedFeeds` fields to `importWalker` and merge branch in `walk`; assemble merged channel in `Run`; add `applyImportDefaults` helper. |
| [backend/cmd_import_test.go](backend/cmd_import_test.go) | Modify: update `TestImportWalkerGroupSelectsChildren`; add tests for `applyImportDefaults`, validation, and walker merge mode. |
| [backend/CLAUDE.md](backend/CLAUDE.md) | Modify: update the `cmd_import.go` bullet with merge + Pipe/Ingest flags. |

---

## Task 1: Add `applyImportDefaults` helper

**Goal:** Introduce a pure helper that stamps `Tag` / `Pipe` / `Ingest` onto a slice of `*Channel`s. No new flags yet — Tag goes through this helper instead of the existing inline loop, paving the way for `-p` and `--ingest`.

**Files:**
- Modify: [backend/cmd_import.go](backend/cmd_import.go)
- Modify: [backend/cmd_import_test.go](backend/cmd_import_test.go)

- [ ] **Step 1: Write failing tests for `applyImportDefaults`**

Append to [backend/cmd_import_test.go](backend/cmd_import_test.go):

```go
func TestApplyImportDefaultsNothingSet(t *testing.T) {
	channels := []*Channel{
		{Title: "A", Tag: "auto", Pipe: []string{"#sanitize"}, Ingest: "#rss"},
		{Title: "B"},
	}
	applyImportDefaults(channels, nil, nil, nil)
	// Untouched: existing Tag / Pipe / Ingest preserved.
	if channels[0].Tag != "auto" {
		t.Errorf("channels[0].Tag = %q, want %q", channels[0].Tag, "auto")
	}
	if !slices.Equal(channels[0].Pipe, []string{"#sanitize"}) {
		t.Errorf("channels[0].Pipe = %v, want [#sanitize]", channels[0].Pipe)
	}
	if channels[0].Ingest != "#rss" {
		t.Errorf("channels[0].Ingest = %q, want %q", channels[0].Ingest, "#rss")
	}
}

func TestApplyImportDefaultsTagOverride(t *testing.T) {
	channels := []*Channel{{Title: "A", Tag: "auto"}, {Title: "B", Tag: "other"}}
	tag := "explicit"
	applyImportDefaults(channels, nil, nil, &tag)
	for _, c := range channels {
		if c.Tag != "explicit" {
			t.Errorf("c.Tag = %q, want %q", c.Tag, "explicit")
		}
	}
}

func TestApplyImportDefaultsTagClearsToEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A", Tag: "auto"}}
	empty := ""
	applyImportDefaults(channels, nil, nil, &empty)
	if channels[0].Tag != "" {
		t.Errorf("c.Tag = %q, want empty", channels[0].Tag)
	}
}

func TestApplyImportDefaultsPipeApplied(t *testing.T) {
	channels := []*Channel{{Title: "A"}, {Title: "B"}}
	parsers := []string{"#sanitize", "#minify"}
	applyImportDefaults(channels, &parsers, nil, nil)
	for _, c := range channels {
		if !slices.Equal(c.Pipe, []string{"#sanitize", "#minify"}) {
			t.Errorf("c.Pipe = %v, want [#sanitize #minify]", c.Pipe)
		}
	}
}

func TestApplyImportDefaultsPipeEmptyClears(t *testing.T) {
	channels := []*Channel{{Title: "A", Pipe: []string{"#sanitize"}}}
	parsers := []string{""}
	applyImportDefaults(channels, &parsers, nil, nil)
	if channels[0].Pipe != nil {
		t.Errorf("c.Pipe = %v, want nil (filterPipe drops empties)", channels[0].Pipe)
	}
}

func TestApplyImportDefaultsPipeFiltersEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A"}}
	parsers := []string{"#sanitize", "", "#minify"}
	applyImportDefaults(channels, &parsers, nil, nil)
	if !slices.Equal(channels[0].Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("c.Pipe = %v, want [#sanitize #minify]", channels[0].Pipe)
	}
}

func TestApplyImportDefaultsIngestApplied(t *testing.T) {
	channels := []*Channel{{Title: "A"}, {Title: "B"}}
	ingest := "#telegram"
	applyImportDefaults(channels, nil, &ingest, nil)
	for _, c := range channels {
		if c.Ingest != "#telegram" {
			t.Errorf("c.Ingest = %q, want %q", c.Ingest, "#telegram")
		}
	}
}

func TestApplyImportDefaultsIngestClearsToEmpty(t *testing.T) {
	channels := []*Channel{{Title: "A", Ingest: "#telegram"}}
	empty := ""
	applyImportDefaults(channels, nil, &empty, nil)
	if channels[0].Ingest != "" {
		t.Errorf("c.Ingest = %q, want empty", channels[0].Ingest)
	}
}
```

Also add the `slices` import to the test file. If `cmd_import_test.go` does not yet import `slices`, change:

```go
import (
	"io"
	"testing"
)
```

to:

```go
import (
	"io"
	"slices"
	"testing"
)
```

- [ ] **Step 2: Run tests; verify they fail**

Run from `/home/gllera/ws/srr/backend`:

```bash
go test -run 'TestApplyImportDefaults' .
```

Expected: build error / `undefined: applyImportDefaults`.

- [ ] **Step 3: Implement `applyImportDefaults`**

Append to [backend/cmd_import.go](backend/cmd_import.go) (place it near the bottom, after `resolveTag`):

```go
// applyImportDefaults stamps Pipe / Ingest / Tag onto every channel
// emitted by the importer. Each pointer is `nil` when the corresponding
// CLI flag is absent. parsers passes through filterPipe so empty entries
// drop and an all-empty input becomes nil (inherit-root semantics).
func applyImportDefaults(channels []*Channel, parsers *[]string, ingest, tag *string) {
	if parsers != nil {
		pipe := filterPipe(*parsers)
		for _, c := range channels {
			c.Pipe = pipe
		}
	}
	if ingest != nil {
		for _, c := range channels {
			c.Ingest = *ingest
		}
	}
	if tag != nil {
		for _, c := range channels {
			c.Tag = *tag
		}
	}
}
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
go test -run 'TestApplyImportDefaults' .
```

Expected: `ok` with all 8 tests passing.

- [ ] **Step 5: Wire `applyImportDefaults` into `Run` (replace inline Tag loop)**

In [backend/cmd_import.go](backend/cmd_import.go), find the existing block:

```go
// Resolve tags
if o.Tag != nil {
	for _, c := range newChannels {
		c.Tag = *o.Tag
	}
}
```

Replace it with:

```go
applyImportDefaults(newChannels, nil, nil, o.Tag)
```

(Other args stay `nil` for now — they become wired in Task 2.)

- [ ] **Step 6: Run the full backend test suite to confirm no regressions**

```bash
go test ./...
```

Expected: `ok` across all packages.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_import.go backend/cmd_import_test.go
git commit -m "refactor(import): extract applyImportDefaults helper"
```

---

## Task 2: Add `-p/--parsers` and `--ingest` flags

**Goal:** Expose `applyImportDefaults`' pipe/ingest paths via two new CLI flags. Every imported channel — whether merged (not yet implemented) or per-leaf — receives the same `Pipe` / `Ingest`.

**Files:**
- Modify: [backend/cmd_import.go](backend/cmd_import.go)
- Modify: [backend/cmd_import_test.go](backend/cmd_import_test.go)

- [ ] **Step 1: Write failing integration test for flag plumbing**

Append to [backend/cmd_import_test.go](backend/cmd_import_test.go):

```go
func TestImportRunFlagsThreadIntoChannels(t *testing.T) {
	// Drive applyImportDefaults via the same call site Run uses, with
	// fields populated from an ImportCmd. Guards the wiring after the
	// rename / refactor.
	parsers := []string{"#sanitize", "#minify"}
	ingest := "#telegram"
	tag := "news"
	o := &ImportCmd{Parsers: &parsers, Ingest: &ingest, Tag: &tag}

	channels := []*Channel{{Title: "A"}}
	applyImportDefaults(channels, o.Parsers, o.Ingest, o.Tag)

	if !slices.Equal(channels[0].Pipe, []string{"#sanitize", "#minify"}) {
		t.Errorf("Pipe = %v", channels[0].Pipe)
	}
	if channels[0].Ingest != "#telegram" {
		t.Errorf("Ingest = %q", channels[0].Ingest)
	}
	if channels[0].Tag != "news" {
		t.Errorf("Tag = %q", channels[0].Tag)
	}
}
```

- [ ] **Step 2: Run test; verify it fails**

```bash
go test -run 'TestImportRunFlagsThreadIntoChannels' .
```

Expected: build error / `unknown field Parsers in struct literal of type ImportCmd` (and same for `Ingest`).

- [ ] **Step 3: Add `Parsers` and `Ingest` fields to `ImportCmd`**

In [backend/cmd_import.go](backend/cmd_import.go), change the `ImportCmd` struct from:

```go
type ImportCmd struct {
	Path   string   `arg:""    help:"Channels opml file."`
	ID     []string `short:"i" help:"Ids to import."`
	All    bool     `short:"a" help:"Import all."`
	Tag    *string  `short:"g" help:"Tag to assign to imported channels. Overrides OPML group tags."`
	DryRun bool     `short:"n" help:"Dry run. List resulting channels without importing."`
}
```

to:

```go
type ImportCmd struct {
	Path    string    `arg:""               help:"Channels opml file."`
	ID      []string  `short:"i"            help:"Ids to import."`
	All     bool      `short:"a"            help:"Import all."`
	Tag     *string   `short:"g"            help:"Tag to assign to imported channels. Overrides OPML group tags."`
	DryRun  bool      `short:"n"            help:"Dry run. List resulting channels without importing."`
	Parsers *[]string `short:"p" optional:"" help:"Channel pipe applied to every imported channel. Repeatable. Empty (\"\") clears (inherit root)."`
	Ingest  *string   `          optional:"" help:"Channel ingest strategy applied to every imported channel. Empty (\"\") clears (inherit root)."`
}
```

- [ ] **Step 4: Wire new flags into the `applyImportDefaults` call in `Run`**

In [backend/cmd_import.go](backend/cmd_import.go), change:

```go
applyImportDefaults(newChannels, nil, nil, o.Tag)
```

to:

```go
applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)
```

- [ ] **Step 5: Run new test + full suite**

```bash
go test -run 'TestImportRunFlagsThreadIntoChannels' .
go test ./...
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_import.go backend/cmd_import_test.go
git commit -m "feat(import): add -p/--parsers and --ingest flags"
```

---

## Task 3: Add `-t/--title` field + validation

**Goal:** Add the merge-trigger flag and reject invalid combinations early (`-t ""`, `-t` without selection). No merge behavior yet — Title is plumbed through but not consumed; validation alone is the surface change visible to users.

**Files:**
- Modify: [backend/cmd_import.go](backend/cmd_import.go)
- Modify: [backend/cmd_import_test.go](backend/cmd_import_test.go)

- [ ] **Step 1: Write failing validation tests**

Append to [backend/cmd_import_test.go](backend/cmd_import_test.go):

```go
func TestImportRunEmptyTitleErrors(t *testing.T) {
	empty := ""
	cmd := &ImportCmd{Path: "irrelevant.opml", All: true, Title: &empty}
	err := cmd.Run()
	if err == nil || !strings.Contains(err.Error(), "title must be non-empty") {
		t.Errorf("got err=%v, want error about empty title", err)
	}
}

func TestImportRunTitleWithoutSelectionErrors(t *testing.T) {
	title := "X"
	cmd := &ImportCmd{Path: "irrelevant.opml", Title: &title}
	err := cmd.Run()
	if err == nil || !strings.Contains(err.Error(), "merge requires -a or -i") {
		t.Errorf("got err=%v, want error about missing selection", err)
	}
}
```

Both tests rely on validation firing *before* `ParseOPMLTree`, so the bogus `Path` never matters.

Add `"strings"` to the test-file imports if not already present.

- [ ] **Step 2: Run tests; verify they fail**

```bash
go test -run 'TestImportRun(EmptyTitleErrors|TitleWithoutSelectionErrors)' .
```

Expected: build error / `unknown field Title in struct literal of type ImportCmd`.

- [ ] **Step 3: Add `Title` field**

In [backend/cmd_import.go](backend/cmd_import.go), change the `ImportCmd` struct (line written in Task 2) to also include `Title`. The full struct becomes:

```go
type ImportCmd struct {
	Path    string    `arg:""                help:"Channels opml file."`
	ID      []string  `short:"i"             help:"Ids to import."`
	All     bool      `short:"a"             help:"Import all."`
	Tag     *string   `short:"g"             help:"Tag to assign to imported channels. Overrides OPML group tags."`
	DryRun  bool      `short:"n"             help:"Dry run. List resulting channels without importing."`
	Title   *string   `short:"t" optional:"" help:"Title for the merged channel. Triggers merge mode (all selections become one channel)."`
	Parsers *[]string `short:"p" optional:"" help:"Channel pipe applied to every imported channel. Repeatable. Empty (\"\") clears (inherit root)."`
	Ingest  *string   `          optional:"" help:"Channel ingest strategy applied to every imported channel. Empty (\"\") clears (inherit root)."`
}
```

- [ ] **Step 4: Add validation at the top of `Run`**

In [backend/cmd_import.go](backend/cmd_import.go), insert at the top of `ImportCmd.Run` (immediately after the function signature, before `ParseOPMLTree`):

```go
if o.Title != nil {
	if *o.Title == "" {
		return fmt.Errorf("title must be non-empty")
	}
	if !o.All && len(o.ID) == 0 {
		return fmt.Errorf("merge requires -a or -i")
	}
}
```

- [ ] **Step 5: Run new tests + full suite**

```bash
go test -run 'TestImportRun(EmptyTitleErrors|TitleWithoutSelectionErrors)' .
go test ./...
```

Expected: both new tests pass; nothing else regresses.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_import.go backend/cmd_import_test.go
git commit -m "feat(import): add -t/--title flag with merge-mode validation"
```

---

## Task 4: Implement merge mode in `importWalker`

**Goal:** When `merge == true`, `walk` appends every selected leaf's `*Feed` to `iw.mergedFeeds` instead of returning a `*Channel`. Group nodes that themselves carry a feed (`n.Channel != nil && len(n.Children) > 0`) contribute their feed too. The returned `[]*Channel` is empty in merge mode; `Run` (Task 5) assembles the single channel from the accumulator.

**Files:**
- Modify: [backend/cmd_import.go](backend/cmd_import.go)
- Modify: [backend/cmd_import_test.go](backend/cmd_import_test.go)

- [ ] **Step 1: Write failing walker merge tests**

Append to [backend/cmd_import_test.go](backend/cmd_import_test.go):

```go
func TestWalkerMergeFlatLeaves(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Alpha", Channel: &Channel{Title: "Alpha", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Beta", Channel: &Channel{Title: "Beta", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
		{Name: "Gamma", Channel: &Channel{Title: "Gamma", Feeds: []*Feed{{URL: "http://example.com/g"}}}},
	}
	iw := &importWalker{w: io.Discard, merge: true}
	channels, err := iw.walk(nodes, "", "", nil, true /* importAll */)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("merge mode returned %d channels, want 0", len(channels))
	}
	if len(iw.mergedFeeds) != 3 {
		t.Fatalf("mergedFeeds len = %d, want 3", len(iw.mergedFeeds))
	}
	wantURLs := []string{"http://example.com/a", "http://example.com/b", "http://example.com/g"}
	for i, f := range iw.mergedFeeds {
		if f.URL != wantURLs[i] {
			t.Errorf("mergedFeeds[%d].URL = %q, want %q", i, f.URL, wantURLs[i])
		}
	}
}

func TestWalkerMergeGroupCollectsSubtree(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	channels, err := iw.walk(nodes, "", "", nil, false /* importAll */)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("got %d channels, want 0 (merge)", len(channels))
	}
	if len(iw.mergedFeeds) != 2 {
		t.Fatalf("mergedFeeds len = %d, want 2", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeDeepNested(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{
					Name: "Rust",
					Children: []*OPMLNode{
						{Name: "R1", Channel: &Channel{Title: "R1", Feeds: []*Feed{{URL: "http://example.com/r1"}}}},
						{Name: "R2", Channel: &Channel{Title: "R2", Feeds: []*Feed{{URL: "http://example.com/r2"}}}},
					},
				},
				{
					Name: "Go",
					Children: []*OPMLNode{
						{Name: "G1", Channel: &Channel{Title: "G1", Feeds: []*Feed{{URL: "http://example.com/g1"}}}},
					},
				},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 3 {
		t.Errorf("got %d feeds, want 3 (R1, R2, G1)", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeGroupWithSelfFeed(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name:    "Self",
			Channel: &Channel{Title: "Self", Feeds: []*Feed{{URL: "http://example.com/self"}}},
			Children: []*OPMLNode{
				{Name: "Child", Channel: &Channel{Title: "Child", Feeds: []*Feed{{URL: "http://example.com/child"}}}},
			},
		},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 2 {
		t.Fatalf("got %d feeds, want 2 (self + child)", len(iw.mergedFeeds))
	}
	// Self feed contributes first (group node visited before children).
	if iw.mergedFeeds[0].URL != "http://example.com/self" {
		t.Errorf("mergedFeeds[0].URL = %q, want self feed", iw.mergedFeeds[0].URL)
	}
}

func TestWalkerMergeMixedLeafAndGroup(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
		{Name: "Standalone", Channel: &Channel{Title: "Standalone", Feeds: []*Feed{{URL: "http://example.com/s"}}}},
	}
	// Select group 1 (Tech) and leaf 2 (Standalone).
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1", "2"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 3 {
		t.Errorf("got %d feeds, want 3", len(iw.mergedFeeds))
	}
}

func TestWalkerMergeSingleLeaf(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Solo", Channel: &Channel{Title: "Solo", Feeds: []*Feed{{URL: "http://example.com/solo"}}}},
	}
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, false); err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(iw.mergedFeeds) != 1 {
		t.Errorf("got %d feeds, want 1", len(iw.mergedFeeds))
	}
}
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
go test -run 'TestWalkerMerge' .
```

Expected: build error / `unknown field merge in struct literal of type importWalker`.

- [ ] **Step 3: Add `merge` + `mergedFeeds` to `importWalker`**

In [backend/cmd_import.go](backend/cmd_import.go), change:

```go
type importWalker struct {
	w           io.Writer
	selectedIDs []string
}
```

to:

```go
type importWalker struct {
	w           io.Writer
	selectedIDs []string
	merge       bool      // true when -t is set; selected feeds accumulate into mergedFeeds instead of becoming channels
	mergedFeeds []*Feed   // accumulator (merge mode only)
}
```

- [ ] **Step 4: Implement the merge branch in `walk`**

In [backend/cmd_import.go](backend/cmd_import.go), replace the entire `walk` method body with the version below. (Reproducing the function in full because the merge branches interleave with existing logic; do not try to apply a partial diff.)

```go
func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Channel, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Channel

	emit := func(ch *Channel) error {
		if iw.merge {
			iw.mergedFeeds = append(iw.mergedFeeds, ch.Feeds...)
			return nil
		}
		tag, err := resolveTag(groupPath)
		if err != nil {
			return err
		}
		ch.Tag = tag
		result = append(result, ch)
		return nil
	}

	for i, n := range nodes {
		id := prefix + strconv.Itoa(i+1)

		if n.Channel != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Channel.URLs())
			if iw.isSelected(id, importAll) {
				if err := emit(n.Channel); err != nil {
					return nil, err
				}
			}
		} else if len(n.Children) > 0 {
			fmt.Fprintf(iw.w, "%s\t%s[%s]\t-\n", id, indent, n.Name)

			if n.Channel != nil {
				chID := id + ".0"
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", chID, indent, n.Name, n.Channel.URLs())
				if iw.isSelected(chID, importAll) || iw.isSelected(id, false) {
					if err := emit(n.Channel); err != nil {
						return nil, err
					}
				}
			}

			childImportAll := importAll || iw.isSelected(id, false)
			childPath := append(append([]string{}, groupPath...), n.Name)
			channels, err := iw.walk(n.Children, id+".", indent+"  ", childPath, childImportAll)
			if err != nil {
				return nil, err
			}
			result = append(result, channels...)
		}
	}

	return result, nil
}
```

The only behavioral change is the new `emit` closure (`if iw.merge { ... }`). All other lines are byte-for-byte identical to the existing implementation.

- [ ] **Step 5: Run walker merge tests + full suite**

```bash
go test -run 'TestWalkerMerge' .
go test ./...
```

Expected: all six new tests pass; existing tests still pass (this task does not yet call `walk` with `merge=true` from `Run`, so no end-to-end behavior change).

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_import.go backend/cmd_import_test.go
git commit -m "feat(import): walker merge mode collects feeds into accumulator"
```

---

## Task 5: Assemble merged channel in `Run`

**Goal:** Wire merge mode end-to-end: when `o.Title != nil`, `Run` creates the walker with `merge=true`, builds one `*Channel` from `iw.mergedFeeds`, and pipes it through `applyImportDefaults` like any other emitted channel. Also update the legacy `TestImportWalkerGroupSelectsChildren` to assert that *non-merge* behavior is unchanged.

**Files:**
- Modify: [backend/cmd_import.go](backend/cmd_import.go)
- Modify: [backend/cmd_import_test.go](backend/cmd_import_test.go)

- [ ] **Step 1: Write a failing end-to-end merge test**

The existing test pattern operates on `walk` directly, but the merge assembly happens in `Run`. Test it by replicating Run's post-walk assembly logic in the test (the helper we exercise is `applyImportDefaults`; the merged-channel construction is short enough to inline):

Append to [backend/cmd_import_test.go](backend/cmd_import_test.go):

```go
func TestImportRunAssemblesMergedChannel(t *testing.T) {
	nodes := []*OPMLNode{
		{Name: "Alpha", Channel: &Channel{Title: "Alpha", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
		{Name: "Beta", Channel: &Channel{Title: "Beta", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
	}
	title := "Merged"
	iw := &importWalker{w: io.Discard, merge: true}
	if _, err := iw.walk(nodes, "", "", nil, true); err != nil {
		t.Fatalf("walk: %v", err)
	}

	// Simulate Run's assembly step.
	var newChannels []*Channel
	if iw.merge && len(iw.mergedFeeds) > 0 {
		newChannels = []*Channel{{Title: title, Feeds: iw.mergedFeeds}}
	}

	if len(newChannels) != 1 {
		t.Fatalf("got %d channels, want 1", len(newChannels))
	}
	if newChannels[0].Title != "Merged" {
		t.Errorf("Title = %q, want Merged", newChannels[0].Title)
	}
	if len(newChannels[0].Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2", len(newChannels[0].Feeds))
	}
	if newChannels[0].Tag != "" {
		t.Errorf("Tag = %q, want empty (no -g, no per-leaf auto-tag in merge mode)", newChannels[0].Tag)
	}
}
```

This test pins down the assembly contract. It will continue to pass after Step 3 too — the production code mirrors it.

- [ ] **Step 2: Update `TestImportWalkerGroupSelectsChildren` to be explicit about non-merge**

In [backend/cmd_import_test.go](backend/cmd_import_test.go), find:

```go
func TestImportWalkerGroupSelectsChildren(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
	}

	// Selecting the group "1" should import all children
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}}
	channels, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 2 {
		t.Errorf("got %d channels, want 2 (selecting group imports all children)", len(channels))
	}
}
```

Rename it to `TestImportWalkerGroupSelectsChildrenNoMerge` and leave the body unchanged (it documents the unchanged non-merge behavior):

```go
func TestImportWalkerGroupSelectsChildrenNoMerge(t *testing.T) {
	nodes := []*OPMLNode{
		{
			Name: "Tech",
			Children: []*OPMLNode{
				{Name: "Blog A", Channel: &Channel{Title: "Blog A", Feeds: []*Feed{{URL: "http://example.com/a"}}}},
				{Name: "Blog B", Channel: &Channel{Title: "Blog B", Feeds: []*Feed{{URL: "http://example.com/b"}}}},
			},
		},
	}

	// Without merge mode, selecting the group "1" still imports each child as
	// its own channel — exercising the legacy (pre-merge) path.
	iw := &importWalker{w: io.Discard, selectedIDs: []string{"1"}}
	channels, err := iw.walk(nodes, "", "", nil, false)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	if len(channels) != 2 {
		t.Errorf("got %d channels, want 2 (legacy path: group selection expands to children)", len(channels))
	}
}
```

- [ ] **Step 3: Run the new test; verify it passes**

```bash
go test -run 'TestImportRunAssemblesMergedChannel|TestImportWalkerGroupSelectsChildren' .
```

Expected: both pass. (No production change yet — these tests cover walker behavior already implemented in Task 4 plus the assembly contract that Step 4 will install in production code.)

- [ ] **Step 4: Wire merge mode into `Run`**

In [backend/cmd_import.go](backend/cmd_import.go), update `Run`. The existing function (post-Task 3) looks like:

```go
func (o *ImportCmd) Run() error {
	if o.Title != nil {
		if *o.Title == "" {
			return fmt.Errorf("title must be non-empty")
		}
		if !o.All && len(o.ID) == 0 {
			return fmt.Errorf("merge requires -a or -i")
		}
	}

	nodes, err := ParseOPMLTree(o.Path)
	if err != nil {
		return err
	}

	var output io.Writer = os.Stdout
	if !o.DryRun && (o.All || len(o.ID) > 0) {
		output = io.Discard
	}
	w := tabwriter.NewWriter(output, 1, 1, 2, ' ', 0)

	fmt.Fprintf(w, "ID\tTitle\tURL\n")
	fmt.Fprintf(w, "---\t-----\t---\n")

	iw := &importWalker{w: w, selectedIDs: o.ID}
	newChannels, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if len(newChannels) == 0 {
		return nil
	}

	applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)

	// ... DryRun branch + withDB branch
}
```

Make three localised changes:

(a) Construct the walker with `merge` set:

```go
	iw := &importWalker{w: w, selectedIDs: o.ID, merge: o.Title != nil}
```

(b) After `w.Flush()`, before the `if len(newChannels) == 0` early-return, assemble the merged channel:

```go
	if iw.merge {
		if len(iw.mergedFeeds) == 0 {
			return nil // nothing matched
		}
		newChannels = []*Channel{{
			Title: *o.Title,
			Feeds: iw.mergedFeeds,
		}}
	}
```

(c) (No change needed below — `applyImportDefaults`, DryRun, and `withDB` all consume `newChannels` uniformly.)

The final `Run` reads:

```go
func (o *ImportCmd) Run() error {
	if o.Title != nil {
		if *o.Title == "" {
			return fmt.Errorf("title must be non-empty")
		}
		if !o.All && len(o.ID) == 0 {
			return fmt.Errorf("merge requires -a or -i")
		}
	}

	nodes, err := ParseOPMLTree(o.Path)
	if err != nil {
		return err
	}

	var output io.Writer = os.Stdout
	if !o.DryRun && (o.All || len(o.ID) > 0) {
		output = io.Discard
	}
	w := tabwriter.NewWriter(output, 1, 1, 2, ' ', 0)

	fmt.Fprintf(w, "ID\tTitle\tURL\n")
	fmt.Fprintf(w, "---\t-----\t---\n")

	iw := &importWalker{w: w, selectedIDs: o.ID, merge: o.Title != nil}
	newChannels, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if iw.merge {
		if len(iw.mergedFeeds) == 0 {
			return nil
		}
		newChannels = []*Channel{{
			Title: *o.Title,
			Feeds: iw.mergedFeeds,
		}}
	}

	if len(newChannels) == 0 {
		return nil
	}

	applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)

	if o.DryRun {
		w = tabwriter.NewWriter(os.Stdout, 1, 1, 2, ' ', 0)
		fmt.Fprintf(w, "\nTitle\tURL\tTag\n")
		fmt.Fprintf(w, "-----\t---\t---\n")
		for _, c := range newChannels {
			fmt.Fprintf(w, "%s\t%s\t%s\n", c.Title, c.URLs(), c.Tag)
		}
		w.Flush()
		return nil
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		for _, c := range newChannels {
			if err := db.AddChannel(c); err != nil {
				return err
			}
		}
		return db.Commit(ctx)
	})
}
```

- [ ] **Step 5: Run the full suite**

```bash
go test ./...
```

Expected: every test passes.

- [ ] **Step 6: Smoke-test the CLI manually (optional but recommended)**

Build and run against a small OPML file:

```bash
go build -o /tmp/srr .
cat > /tmp/test.opml <<'EOF'
<?xml version="1.0"?>
<opml version="2.0"><body>
<outline title="Tech">
  <outline title="Blog A" xmlUrl="http://example.com/a"/>
  <outline title="Blog B" xmlUrl="http://example.com/b"/>
</outline>
<outline title="Standalone" xmlUrl="http://example.com/s"/>
</body></opml>
EOF
/tmp/srr chan import /tmp/test.opml -i 1 -t "Tech Roundup" -p "#sanitize" --ingest "#rss" -n
```

Expected dry-run output: one channel "Tech Roundup" with the two Tech URLs joined by `, `.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_import.go backend/cmd_import_test.go
git commit -m "feat(import): assemble merged channel and finalise -t flow"
```

---

## Task 6: Update `backend/CLAUDE.md`

**Goal:** Reflect the new flags so the bullet remains an accurate one-line summary.

**Files:**
- Modify: [backend/CLAUDE.md](backend/CLAUDE.md)

- [ ] **Step 1: Update the `cmd_import.go` bullet**

In [backend/CLAUDE.md](backend/CLAUDE.md), find:

```markdown
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-n/--dry-run` lists resulting channels without importing.
```

Replace it with:

```markdown
- **`cmd_import.go`** — OPML import with hierarchical ID selection (`-a` all, `-i` specific). OPML group hierarchy auto-resolves to hierarchical tags; `-g/--tag` overrides. `-t/--title` triggers merge mode (every selection collapses into one channel with N feeds; `-t ""` or `-t` without selection errors). `-p/--parsers` and `--ingest` stamp every imported channel (merged or per-leaf). `-n/--dry-run` lists resulting channels without importing. `applyImportDefaults` centralises post-walk Tag/Pipe/Ingest stamping.
```

- [ ] **Step 2: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "docs(backend): document import merge + Pipe/Ingest flags"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite one last time**

```bash
go test ./...
```

Expected: every package passes.

- [ ] **Step 2: Run `go vet`**

```bash
go vet ./...
```

Expected: clean.

- [ ] **Step 3: Confirm formatting**

```bash
gofmt -l .
```

Expected: no output (no files need reformatting). If any file is listed, run `gofmt -w .` and amend the most recent commit.

- [ ] **Step 4: Manual CLI smoke (optional)**

If not already done in Task 5 Step 6, run the smoke test there. Try also:

```bash
/tmp/srr chan import /tmp/test.opml -a -t "All" -p "#sanitize" -p "#minify" -n
/tmp/srr chan import /tmp/test.opml -a -t "" -n            # expect: title must be non-empty
/tmp/srr chan import /tmp/test.opml -t "X" -n              # expect: merge requires -a or -i
/tmp/srr chan import /tmp/test.opml -a -p "" -n            # expect: per-leaf channels, Pipe cleared to nil
```
