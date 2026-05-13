# Channel Management CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `srr chan …` to (1) split create/update verbs, (2) collapse `add-feed` / `rm-feed` into flags on `chan upd`, (3) add `show` / `apply` / `edit` for inspection + scripted editing, (4) drop the per-feed `Feed.Ingest` field entirely.

**Architecture:** Pure Go CLI work in `backend/`. All commands run inside `withDB(true, fn)` so each `Run()` is a single atomic transaction. A new shared `channelView` type backs `ls` / `show` / `apply` / `edit` so encode and decode share one schema. The data-model change (drop `Feed.Ingest`) is the only field-level mutation; ingest precedence collapses to channel → global → `#rss`.

**Tech Stack:** Go, `alecthomas/kong` (CLI), `gopkg.in/yaml.v3`, `encoding/json`. Tests are stdlib `testing`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-13-channel-feed-cli-design.md](docs/superpowers/specs/2026-05-13-channel-feed-cli-design.md)

---

## File Map

| File | Action |
|---|---|
| [backend/ingest/main.go](backend/ingest/main.go) | Modify: `Select` becomes 2-arg `(channelFetcher, globalFetcher)`; update doc comment. |
| [backend/feed.go](backend/feed.go) | Modify: drop `Feed.Ingest` struct field + its comment; rewrite `pickIngest` to take only `*Channel`; update one call site. |
| [backend/feed_test.go](backend/feed_test.go) | Modify: delete `TestFeedFetchDispatchesByIngestField`; update `TestPickIngest*` signatures to single arg. |
| [backend/cmd_preview.go](backend/cmd_preview.go) | Modify: update `ingest.Select` call site (line 74). |
| [backend/channel.go](backend/channel.go) | (unchanged — `Feed.Ingest` lives in `feed.go`) |
| [backend/cmd_chans.go](backend/cmd_chans.go) | Rewrite: drop `--upd` from `AddCmd`; delete `AddFeedCmd` / `RmFeedCmd`; add `UpdCmd`, `ShowCmd`, `ApplyCmd`, `EditCmd`; introduce shared `channelView`/`feedView` types; refactor `printFormatted` to take `io.Writer`. |
| [backend/cmd_chans_test.go](backend/cmd_chans_test.go) | Rewrite to match: migrate tests for renames; add new tests for `Upd` / `Show` / `Apply` / `Edit`. |
| [backend/main.go](backend/main.go) | Modify `ChannelGroup`: drop `AddFeed`, `RmFeed`; add `Upd`, `Show`, `Apply`, `Edit`. |
| [backend/CLAUDE.md](backend/CLAUDE.md) | Update `cmd_chans.go` blurb, ingest precedence paragraph, and `Channel`/`Feed` field list. |

---

## Phase 1 — Drop `Feed.Ingest`

### Task 1: Collapse `ingest.Select` to two-arg

**Files:**
- Modify: [backend/ingest/main.go](backend/ingest/main.go)
- Modify: [backend/feed.go](backend/feed.go)
- Modify: [backend/cmd_preview.go](backend/cmd_preview.go)
- Modify: [backend/feed_test.go](backend/feed_test.go)

- [ ] **Step 1: Update `Select` signature and doc comment**

In `backend/ingest/main.go`, replace the existing comment + signature (around lines 92–101) with:

```go
// Select applies the caller's precedence rule: channel > global default
// > built-in "#rss". Empty strings fall through.
func Select(channelFetcher, globalFetcher string) string {
	for _, name := range []string{channelFetcher, globalFetcher} {
		if name != "" {
			return name
		}
	}
	return "#rss"
}
```

- [ ] **Step 2: Rewrite `pickIngest` to take only `*Channel`**

In `backend/feed.go`, replace `pickIngest` (lines 139–148) with:

```go
// pickIngest resolves the Ingest name for a channel via the
// channel > global default precedence. globals may be nil during
// tests run before main() initialises it.
func pickIngest(ch *Channel) string {
	var def string
	if globals != nil {
		def = globals.DefaultIngest
	}
	return ingest.Select(ch.Ingest, def)
}
```

- [ ] **Step 3: Update the single `pickIngest` call site**

In `backend/feed.go` line 41, change:

```go
	name := pickIngest(feed, ch)
```

to:

```go
	name := pickIngest(ch)
```

- [ ] **Step 4: Update `cmd_preview.go` `ingest.Select` call site**

In `backend/cmd_preview.go` line 74, change:

```go
	name := ingest.Select(o.Ingest, "", globals.DefaultIngest)
```

to:

```go
	name := ingest.Select(o.Ingest, globals.DefaultIngest)
```

(Preview has no real `Channel`; the CLI `-i/--ingest` flag plays the channel-level role.)

- [ ] **Step 5: Update `pickIngest` test signatures**

In `backend/feed_test.go`, change the two `pickIngest` tests (lines 68–86) from two-arg to one-arg:

```go
func TestPickIngestNilGlobals(t *testing.T) {
	saved := globals
	defer func() { globals = saved }()
	globals = nil

	if got := pickIngest(&Channel{}); got != "#rss" {
		t.Errorf("got %q, want %q", got, "#rss")
	}
}

func TestPickIngestReadsGlobalDefault(t *testing.T) {
	saved := globals
	defer func() { globals = saved }()
	globals = &Globals{DefaultIngest: "#telegram"}

	if got := pickIngest(&Channel{}); got != "#telegram" {
		t.Errorf("got %q, want %q", got, "#telegram")
	}
}
```

- [ ] **Step 6: Delete `TestFeedFetchDispatchesByIngestField`**

In `backend/feed_test.go`, delete lines 41–54 (the comment + the entire `TestFeedFetchDispatchesByIngestField` function). The test sets `Feed.Ingest = "#test-stub"`, but after the precedence change `pickIngest` no longer reads `Feed.Ingest` — the test would route to `#rss` and try a real network fetch. The Channel-level inheritance test (`TestFeedFetchInheritsFromChannel`) keeps coverage of the dispatcher.

- [ ] **Step 7: Build and test**

Run: `cd backend && go build ./... && go test ./...`
Expected: PASS — all remaining tests green.

- [ ] **Step 8: Commit**

```bash
git add backend/ingest/main.go backend/feed.go backend/cmd_preview.go backend/feed_test.go
git commit -m "refactor(ingest): collapse Select to channel > global precedence"
```

---

### Task 2: Remove `Feed.Ingest` field and patch all callers

**Files:**
- Modify: [backend/feed.go](backend/feed.go)
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)

After Task 1, `pickIngest` no longer reads `Feed.Ingest`, but the field is still set in two places: `AddFeedCmd.Run` (line ~155) and `LsCmd.Run`'s `lsFeed` populator. This task drops the field declaration and patches both call sites in one atomic commit.

- [ ] **Step 1: Delete `Feed.Ingest` field and its comment**

In `backend/feed.go`, replace the existing `Feed` struct (lines 14–33) with:

```go
type Feed struct {
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	// Watermark is the max published unix-second ever seen across fetches.
	Watermark int64 `json:"wm,omitempty"`
	// BoundaryGUIDs is the GUIDs from the most recent non-empty fetch whose
	// pub equals Watermark (the dated boundary) or equals 0 (dateless).
	// Repopulated each non-empty fetch from the current response so its size
	// stays bounded by what the publisher currently exposes; a 200 OK with
	// zero items leaves the field untouched so a transient empty channel
	// doesn't drop dedup state.
	BoundaryGUIDs []uint32 `json:"bg,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
}
```

- [ ] **Step 2: Drop the `-i/--ingest` flag and field write in `AddFeedCmd`**

In `backend/cmd_chans.go`, replace `AddFeedCmd` (lines 126–161) with:

```go
type AddFeedCmd struct {
	ID   int      `arg:""            help:"Channel id."`
	URLs []string `arg:"" name:"url" help:"URL(s) to add."`
}

// add-feed is idempotent: URLs already on the channel or duplicated within args
// are silently skipped (mkdir -p semantics). Only invalid URL formats fail.
func (o *AddFeedCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}

		seen := make(map[string]bool, len(ch.Feeds)+len(o.URLs))
		for _, f := range ch.Feeds {
			seen[f.URL] = true
		}
		for _, u := range o.URLs {
			if !validFeedURL(u) {
				return fmt.Errorf("invalid url %q", u)
			}
			if seen[u] {
				continue
			}
			seen[u] = true
			ch.Feeds = append(ch.Feeds, &Feed{URL: u})
		}
		return db.Commit(ctx)
	})
}
```

(Note: `AddFeedCmd` is itself deleted later in Task 6. This intermediate edit just keeps the build green until then.)

- [ ] **Step 3: Drop `Ingest` from `lsFeed` and its populator**

In `backend/cmd_chans.go`, inside `LsCmd.Run` (around line 213), replace the inline `lsFeed` struct definition and its populator with the no-`Ingest` versions:

```go
		type lsFeed struct {
			URL   string `json:"url" yaml:"url"`
			Error string `json:"error,omitempty" yaml:"error,omitempty"`
		}
```

And the corresponding populator line (around line 235):

```go
			feeds[i] = lsFeed{URL: f.URL, Error: f.FetchError}
```

(Channel-level `Ingest` on `lsChannel` stays — only the per-feed field is removed.)

- [ ] **Step 4: Verify no other `Feed.Ingest` references remain**

Run: `grep -rn "Feed\.Ingest\|feed\.Ingest\|\.Ingest *=" backend/ | grep -v "ch\.Ingest\|Channel\.Ingest\|globals\.\|o\.Ingest"`
Expected: zero matches. (`ch.Ingest` / `Channel.Ingest` / globals / command-flag `o.Ingest` are channel-level and legitimate.)

- [ ] **Step 5: Build and test**

Run: `cd backend && go build ./... && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/feed.go backend/cmd_chans.go
git commit -m "feat: drop Feed.Ingest — ingest is channel-level only"
```

---

## Phase 2 — Reshape `cmd_chans.go`

### Task 3: De-overload `AddCmd` (strict create only)

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)

The old `AddCmd` flipped between create and update based on `--upd`. After this task, `chan add` is strict-create. `chan upd` doesn't exist yet — its tests (currently using `AddCmd{Upd: intPtr(...)}`) get removed here and re-added in Task 4 / Task 5.

- [ ] **Step 1: Write the failing test for strict-create with no `--upd`**

In `backend/cmd_chans_test.go`, replace `TestAddCmdCreatesChannel` (around line 245) with:

```go
func TestChanAddCreates(t *testing.T) {
	setupEmptyDB(t)
	cmd := &AddCmd{
		Title: strPtr("News"),
		URLs:  sliceStrPtr([]string{"https://feed.example.com/rss"}),
		Tag:   strPtr("tech"),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}

	db := reopenDB(t)
	if len(db.Channels()) != 1 {
		t.Fatalf("Channels len = %d, want 1", len(db.Channels()))
	}
	ch := db.Channels()[0]
	if ch == nil {
		t.Fatal("expected channel at id 0")
	}
	if ch.Title != "News" {
		t.Errorf("Title = %q, want %q", ch.Title, "News")
	}
	if len(ch.Feeds) != 1 || ch.Feeds[0].URL != "https://feed.example.com/rss" {
		t.Errorf("Feeds = %+v, want one URL", ch.Feeds)
	}
	if ch.Tag != "tech" {
		t.Errorf("Tag = %q, want %q", ch.Tag, "tech")
	}
}
```

Also rename:
- `TestAddCmdCreateRequiresTitle` → `TestChanAddRequiresTitle`
- `TestAddCmdCreateRequiresURL` → `TestChanAddRequiresURL`
- `TestAddCmdCreateMultipleURLs` → `TestChanAddMultipleURLs`

Delete entirely (their behavior moves to `UpdCmd` tests in later tasks):
- `TestAddCmdUpdateChangesTitle`
- `TestAddCmdUpdateEmptyTitleRejected`
- `TestAddCmdUpdateClearsTag`
- `TestAddCmdUpdateSetsPipeline`
- `TestAddCmdUpdateClearsPipeline`
- `TestAddCmdUpdateReplacesFeedsPreservingState`
- `TestAddCmdUpdateRejectsInvalidURL`
- `TestAddCmdUpdateRejectsDuplicateURLs`
- `TestAddCmdUpdateChannelNotFound`

- [ ] **Step 2: Run tests to confirm the rename is clean**

Run: `cd backend && go test -run 'TestChanAdd' .`
Expected: PASS — the renamed Create-side tests still cover `AddCmd` as-is (overloaded `--upd` is unused by them). This is a checkpoint before the struct surgery in Step 3.

(This is one of the refactor tasks where a failing test doesn't drive the change — we're removing a code path, not adding behavior. The strict-create assertion lives in the renamed `TestChanAdd*` tests, plus the existing `TestParseFeeds*` and `TestRmCmd*` tests. Step 4 re-runs the suite to confirm nothing regresses.)

- [ ] **Step 3: Rewrite `AddCmd` to be strict-create**

In `backend/cmd_chans.go`, replace `AddCmd` and its `Run` (lines 39–124) with:

```go
type AddCmd struct {
	Title   *string   `short:"t" required:""              help:"Channel title."`
	URLs    *[]string `short:"u" required:"" name:"url"   help:"Channel RSS url(s); repeat to merge multiple feeds under one id."`
	Tag     *string   `short:"g" optional:""              help:"Channel tag."`
	Parsers *[]string `short:"p" optional:""              help:"Channel parsers commands. Empty (\"\") for default."`
	Ingest  *string   `short:"i" optional:""              help:"Ingest strategy: built-in ('#rss', '#telegram') or shell command."`
}

func (o *AddCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Title == nil || *o.Title == "" {
			return fmt.Errorf("title is required")
		}
		if o.URLs == nil {
			return fmt.Errorf("--url is required")
		}
		feeds, err := parseFeeds(*o.URLs, nil)
		if err != nil {
			return err
		}
		ch := &Channel{Title: *o.Title, Feeds: feeds}
		if o.Tag != nil {
			ch.Tag = *o.Tag
		}
		if o.Parsers != nil {
			for _, p := range *o.Parsers {
				if p != "" {
					ch.Pipeline = append(ch.Pipeline, p)
				}
			}
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}
		if err := db.AddChannel(ch); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
}
```

(Note: Kong's `required:""` will reject the CLI invocation if `-t`/`-u` is missing, but `Run` re-asserts so unit tests that bypass Kong still get the right error.)

- [ ] **Step 4: Run tests**

Run: `cd backend && go test -run 'TestChanAdd|TestRmCmd|TestAddFeed|TestRmFeed|TestLsCmd|TestParseFeeds' .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go
git commit -m "refactor(chan): make chan add strict-create — drop --upd overload"
```

---

### Task 4: Add `UpdCmd` (channel-level fields only)

This task adds `chan upd ID` covering `-t`, `-g`, `-p`, `-i`. Feed-list flags (`-u` / `--add-url` / `--rm-url`) come in Task 5 to keep the diff reviewable.

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)
- Modify: [backend/main.go](backend/main.go)

- [ ] **Step 1: Write the failing tests**

Append to `backend/cmd_chans_test.go`:

```go
func TestChanUpdRequiresFieldFlag(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0}
	wantErr(t, cmd.Run(), "nothing to update")
}

func TestChanUpdChannelNotFound(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 99, Title: strPtr("X")}
	wantErr(t, cmd.Run(), "not found")
}

func TestChanUpdChangesTitle(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, Title: strPtr("New Title")}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Title != "New Title" {
		t.Errorf("Title = %q, want %q", ch.Title, "New Title")
	}
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (untouched)", len(ch.Feeds))
	}
}

func TestChanUpdEmptyTitleRejected(t *testing.T) {
	setupChannelsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, Title: strPtr("")}).Run(), "title cannot be empty")
}

func TestChanUpdClearsTag(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("set tag: %v", err)
	}
	if reopenDB(t).Channels()[0].Tag != "tech" {
		t.Fatal("setup: tag not set")
	}
	if err := (&UpdCmd{ID: 0, Tag: strPtr("")}).Run(); err != nil {
		t.Fatalf("clear tag: %v", err)
	}
	if got := reopenDB(t).Channels()[0].Tag; got != "" {
		t.Errorf("Tag = %q, want \"\"", got)
	}
}

func TestChanUpdSetsPipeline(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{"#sanitize", "#minify"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Pipeline) != 2 || ch.Pipeline[0] != "#sanitize" || ch.Pipeline[1] != "#minify" {
		t.Errorf("Pipeline = %v, want [#sanitize #minify]", ch.Pipeline)
	}
}

func TestChanUpdClearsPipeline(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{"#sanitize"})}).Run(); err != nil {
		t.Fatalf("set pipeline: %v", err)
	}
	if err := (&UpdCmd{ID: 0, Parsers: sliceStrPtr([]string{""})}).Run(); err != nil {
		t.Fatalf("clear pipeline: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Pipeline) != 0 {
		t.Errorf("Pipeline = %v, want empty", ch.Pipeline)
	}
}

func TestChanUpdNoFeedFlagsLeavesFeedsUntouched(t *testing.T) {
	setupChannelsTestDB(t)
	if err := (&UpdCmd{ID: 0, Title: strPtr("X")}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Fatalf("Feeds len = %d, want 2 (untouched)", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" || ch.Feeds[1].ETag != "etag-b" {
		t.Errorf("ETags changed: %q, %q", ch.Feeds[0].ETag, ch.Feeds[1].ETag)
	}
	if ch.Feeds[0].Watermark != 0x111 || ch.Feeds[1].Watermark != 0x222 {
		t.Errorf("Watermarks changed: %#x, %#x", ch.Feeds[0].Watermark, ch.Feeds[1].Watermark)
	}
}
```

- [ ] **Step 2: Run tests to confirm they fail (undefined `UpdCmd`)**

Run: `cd backend && go test -run 'TestChanUpd' .`
Expected: COMPILE FAIL with `undefined: UpdCmd`.

- [ ] **Step 3: Implement `UpdCmd`**

Append to `backend/cmd_chans.go`:

```go
type UpdCmd struct {
	ID      int       `arg:""              help:"Channel id to update."`
	Title   *string   `short:"t" optional:""              help:"Channel title (empty rejected)."`
	Tag     *string   `short:"g" optional:""              help:"Channel tag. Empty (\"\") to clear."`
	Parsers *[]string `short:"p" optional:""              help:"Channel parsers commands. Empty (\"\") to clear."`
	Ingest  *string   `short:"i" optional:""              help:"Channel ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil {
		return fmt.Errorf("nothing to update")
	}
	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}
		if o.Title != nil {
			if *o.Title == "" {
				return fmt.Errorf("title cannot be empty")
			}
			ch.Title = *o.Title
		}
		if o.Tag != nil {
			ch.Tag = *o.Tag
		}
		if o.Parsers != nil {
			ch.Pipeline = ch.Pipeline[:0]
			for _, p := range *o.Parsers {
				if p != "" {
					ch.Pipeline = append(ch.Pipeline, p)
				}
			}
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}
		return db.Commit(ctx)
	})
}
```

- [ ] **Step 4: Wire into Kong**

In `backend/main.go`, change `ChannelGroup` (lines 31–38) to add `Upd`:

```go
type ChannelGroup struct {
	Add     AddCmd     `cmd:"" help:"Subscribe to RSS."`
	Upd     UpdCmd     `cmd:"" help:"Update an existing channel."`
	Rm      RmCmd      `cmd:"" help:"Unsubscribe from channel(s)."`
	AddFeed AddFeedCmd `cmd:"" help:"Add URL(s) to an existing channel."`
	RmFeed  RmFeedCmd  `cmd:"" help:"Remove URL(s) from an existing channel."`
	Ls      LsCmd      `cmd:"" help:"List channels."`
	Import  ImportCmd  `cmd:"" help:"Import opml channels file."`
}
```

(`AddFeed`/`RmFeed` stay one more task; deleted in Task 6.)

- [ ] **Step 5: Run tests**

Run: `cd backend && go test -run 'TestChanUpd' .`
Expected: PASS for all 8 tests.

Also run full suite: `cd backend && go test ./...` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go backend/main.go
git commit -m "feat(chan): add 'chan upd ID' for channel-level field edits"
```

---

### Task 5: Add feed-list flags to `UpdCmd`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)

The three flags (`-u`, `--add-url`, `--rm-url`) are mutually exclusive: passing more than one is an error.

- [ ] **Step 1: Write failing tests for `-u` (replace)**

Append to `backend/cmd_chans_test.go`:

```go
func TestChanUpdReplaceFeedsPreservingState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{
		ID: 0,
		URLs: sliceStrPtr([]string{
			"https://a.example.com/feed", // kept (must preserve etag-a)
			"https://c.example.com/feed", // new
		}),
	}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Fatalf("Feeds len = %d, want 2", len(ch.Feeds))
	}
	if ch.Feeds[0].URL != "https://a.example.com/feed" || ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("kept feed state lost: %+v", ch.Feeds[0])
	}
	if ch.Feeds[1].URL != "https://c.example.com/feed" || ch.Feeds[1].ETag != "" {
		t.Errorf("new feed not fresh: %+v", ch.Feeds[1])
	}
}

func TestChanUpdReplaceRejectsInvalidURL(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, URLs: sliceStrPtr([]string{"not-a-url"})}
	wantErr(t, cmd.Run(), "invalid url")
}

func TestChanUpdReplaceRejectsDuplicateURLs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, URLs: sliceStrPtr([]string{
		"https://x.example.com/feed",
		"https://x.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "duplicate url")
}

func TestChanUpdAddURLAppendsAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{
		"https://c.example.com/feed",
		"https://d.example.com/feed",
	})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 4 {
		t.Fatalf("Feeds len = %d, want 4", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" || ch.Feeds[1].ETag != "etag-b" {
		t.Errorf("existing state lost: %q, %q", ch.Feeds[0].ETag, ch.Feeds[1].ETag)
	}
}

func TestChanUpdAddURLIdempotent(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{"https://a.example.com/feed"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (no-op)", len(ch.Feeds))
	}
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("state clobbered: %q", ch.Feeds[0].ETag)
	}
}

func TestChanUpdAddURLInvalid(t *testing.T) {
	setupChannelsTestDB(t)
	wantErr(t, (&UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{"not-a-url"})}).Run(), "invalid url")
}

func TestChanUpdRmURLRemovesAndPreservesState(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{"https://a.example.com/feed"})}
	if err := cmd.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 1 {
		t.Fatalf("Feeds len = %d, want 1", len(ch.Feeds))
	}
	if ch.Feeds[0].URL != "https://b.example.com/feed" || ch.Feeds[0].ETag != "etag-b" {
		t.Errorf("state lost on survivor: %+v", ch.Feeds[0])
	}
}

func TestChanUpdRmURLNotAFeed(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{"https://nope.example.com/feed"})}
	wantErr(t, cmd.Run(), "not a feed")
}

func TestChanUpdRmURLEmptyingFeedListRejected(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{
		"https://a.example.com/feed",
		"https://b.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "no feeds")
	if len(reopenDB(t).Channels()[0].Feeds) != 2 {
		t.Errorf("Feeds changed despite error")
	}
}

func TestChanUpdRmURLDuplicateArgs(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, RmURLs: sliceStrPtr([]string{
		"https://a.example.com/feed",
		"https://a.example.com/feed",
	})}
	wantErr(t, cmd.Run(), "duplicate")
}

func TestChanUpdMutexUrlFlags(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{
		ID:      0,
		URLs:    sliceStrPtr([]string{"https://x.example.com/feed"}),
		AddURLs: sliceStrPtr([]string{"https://y.example.com/feed"}),
	}
	wantErr(t, cmd.Run(), "--url cannot be combined")

	cmd2 := &UpdCmd{
		ID:      0,
		AddURLs: sliceStrPtr([]string{"https://y.example.com/feed"}),
		RmURLs:  sliceStrPtr([]string{"https://a.example.com/feed"}),
	}
	wantErr(t, cmd2.Run(), "--url cannot be combined")
}
```

- [ ] **Step 2: Run tests to verify they fail (undefined fields)**

Run: `cd backend && go test -run 'TestChanUpdReplace|TestChanUpdAddURL|TestChanUpdRmURL|TestChanUpdMutex' .`
Expected: COMPILE FAIL with `unknown field URLs`/`AddURLs`/`RmURLs` in struct literal of type `UpdCmd`.

- [ ] **Step 3: Extend `UpdCmd` struct and `Run`**

In `backend/cmd_chans.go`, replace `UpdCmd` and its `Run` (the version from Task 4) with:

```go
type UpdCmd struct {
	ID      int       `arg:""                                 help:"Channel id to update."`
	Title   *string   `short:"t" optional:""                  help:"Channel title (empty rejected)."`
	URLs    *[]string `short:"u" optional:"" name:"url"       help:"Replace the feed list. Per-URL state preserved for surviving URLs. Mutually exclusive with --add-url and --rm-url."`
	AddURLs *[]string `           optional:"" name:"add-url"   help:"Append URL(s) (idempotent). Mutually exclusive with -u and --rm-url."`
	RmURLs  *[]string `           optional:"" name:"rm-url"    help:"Remove URL(s) (strict). Mutually exclusive with -u and --add-url."`
	Tag     *string   `short:"g" optional:""                  help:"Channel tag. Empty (\"\") to clear."`
	Parsers *[]string `short:"p" optional:""                  help:"Channel parsers commands. Empty (\"\") to clear."`
	Ingest  *string   `short:"i" optional:""                  help:"Channel ingest strategy. Empty (\"\") to clear."`
}

func (o *UpdCmd) Run() error {
	// Mutex on the three feed-list flags.
	urlFlagCount := 0
	if o.URLs != nil {
		urlFlagCount++
	}
	if o.AddURLs != nil {
		urlFlagCount++
	}
	if o.RmURLs != nil {
		urlFlagCount++
	}
	if urlFlagCount > 1 {
		return fmt.Errorf("--url cannot be combined with --add-url/--rm-url")
	}

	if o.Title == nil && o.Tag == nil && o.Parsers == nil && o.Ingest == nil && urlFlagCount == 0 {
		return fmt.Errorf("nothing to update")
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}
		if o.Title != nil {
			if *o.Title == "" {
				return fmt.Errorf("title cannot be empty")
			}
			ch.Title = *o.Title
		}
		if o.Tag != nil {
			ch.Tag = *o.Tag
		}
		if o.Parsers != nil {
			ch.Pipeline = ch.Pipeline[:0]
			for _, p := range *o.Parsers {
				if p != "" {
					ch.Pipeline = append(ch.Pipeline, p)
				}
			}
		}
		if o.Ingest != nil {
			ch.Ingest = *o.Ingest
		}

		switch {
		case o.URLs != nil:
			feeds, err := parseFeeds(*o.URLs, ch.Feeds)
			if err != nil {
				return err
			}
			ch.Feeds = feeds
		case o.AddURLs != nil:
			if err := appendURLs(ch, *o.AddURLs); err != nil {
				return err
			}
		case o.RmURLs != nil:
			if err := removeURLs(ch, *o.RmURLs); err != nil {
				return err
			}
		}

		return db.Commit(ctx)
	})
}

// appendURLs adds urls to ch.Feeds idempotently (silent skip on duplicates
// or URLs already on the channel). Invalid URL formats fail.
func appendURLs(ch *Channel, urls []string) error {
	seen := make(map[string]bool, len(ch.Feeds)+len(urls))
	for _, f := range ch.Feeds {
		seen[f.URL] = true
	}
	for _, u := range urls {
		if !validFeedURL(u) {
			return fmt.Errorf("invalid url %q", u)
		}
		if seen[u] {
			continue
		}
		seen[u] = true
		ch.Feeds = append(ch.Feeds, &Feed{URL: u})
	}
	return nil
}

// removeURLs strict-removes urls from ch.Feeds. Errors if any url is not a
// current feed, on duplicate args, or if all feeds would be removed.
func removeURLs(ch *Channel, urls []string) error {
	rmSet := make(map[string]bool, len(urls))
	for _, u := range urls {
		if rmSet[u] {
			return fmt.Errorf("duplicate url %q", u)
		}
		rmSet[u] = true
		if !slices.ContainsFunc(ch.Feeds, func(f *Feed) bool { return f.URL == u }) {
			return fmt.Errorf("url %q is not a feed of channel %d", u, ch.id)
		}
	}
	if len(rmSet) == len(ch.Feeds) {
		return fmt.Errorf("channel %d would have no feeds after removal", ch.id)
	}
	ch.Feeds = slices.DeleteFunc(ch.Feeds, func(f *Feed) bool { return rmSet[f.URL] })
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test -run 'TestChanUpd' .`
Expected: PASS — all 19 `TestChanUpd*` tests.

Also: `cd backend && go test ./...`
Expected: PASS overall.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go
git commit -m "feat(chan upd): add -u/--add-url/--rm-url feed-list flags"
```

---

### Task 6: Delete `AddFeedCmd` and `RmFeedCmd`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)
- Modify: [backend/main.go](backend/main.go)

- [ ] **Step 1: Delete obsolete tests**

In `backend/cmd_chans_test.go`, delete all of these tests entirely (their coverage now lives in the `TestChanUpdAddURL*` / `TestChanUpdRmURL*` tests added in Task 5):

- `TestAddFeedCmdAppendsAndPreservesState`
- `TestAddFeedCmdIdempotentDuplicateInArgs`
- `TestAddFeedCmdIdempotentAlreadyAFeed`
- `TestAddFeedCmdMixedNewAndExisting`
- `TestAddFeedCmdInvalidURL`
- `TestAddFeedCmdChannelNotFound`
- `TestAddFeedCmdIDTooLarge`
- `TestAddFeedCmdIDNegative`
- `TestAddFeedCmdAtomicOnError`
- `TestRmFeedCmdRemovesAndPreservesState`
- `TestRmFeedCmdNotAFeed`
- `TestRmFeedCmdLeavesEmpty`
- `TestRmFeedCmdDuplicateInArgs`
- `TestRmFeedCmdChannelNotFound`
- `TestRmFeedCmdIDNegative`
- `TestRmFeedCmdIDTooLarge`

- [ ] **Step 2: Add coverage gaps from the deleted tests**

The deleted tests checked id-bounds and atomic-on-error behaviour. Append to `backend/cmd_chans_test.go`:

```go
func TestChanUpdIDTooLarge(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 256, AddURLs: sliceStrPtr([]string{"https://x.example.com/feed"})}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestChanUpdIDNegative(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: -1, AddURLs: sliceStrPtr([]string{"https://x.example.com/feed"})}
	wantErr(t, cmd.Run(), "[0, 255]")
}

func TestChanUpdAddURLAtomicOnError(t *testing.T) {
	setupChannelsTestDB(t)
	cmd := &UpdCmd{ID: 0, AddURLs: sliceStrPtr([]string{
		"https://c.example.com/feed",
		"not-a-url",
	})}
	if err := cmd.Run(); err == nil {
		t.Fatal("expected error")
	}
	ch := reopenDB(t).Channels()[0]
	if len(ch.Feeds) != 2 {
		t.Errorf("Feeds len = %d, want 2 (rollback)", len(ch.Feeds))
	}
}
```

- [ ] **Step 3: Delete `AddFeedCmd` and `RmFeedCmd` source**

In `backend/cmd_chans.go`, delete the `AddFeedCmd` type, its `Run`, the `RmFeedCmd` type, and its `Run` (currently lines 126–193 of the post-Task-2 file).

- [ ] **Step 4: Remove from `ChannelGroup` wiring**

In `backend/main.go`, replace the `ChannelGroup` definition with:

```go
type ChannelGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to RSS."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing channel."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from channel(s)."`
	Ls     LsCmd     `cmd:"" help:"List channels."`
	Import ImportCmd `cmd:"" help:"Import opml channels file."`
}
```

- [ ] **Step 5: Run tests**

Run: `cd backend && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go backend/main.go
git commit -m "refactor(chan): delete add-feed/rm-feed in favor of upd flags"
```

---

## Phase 3 — Show / Apply / Edit

### Task 7: Refactor `printFormatted` + introduce `channelView`/`feedView`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)

This is plumbing: a testable encoder (writes to an `io.Writer`) and a single shared shape used by `ls`, `show`, `apply`, `edit`. After this task, `LsCmd` uses the new types but its observable behaviour is unchanged except that the output now includes `pipe`.

- [ ] **Step 1: Write a test asserting `ls` JSON includes `pipe` and uses the shared shape**

Replace the existing `TestLsCmdFiltersByTag` test in `backend/cmd_chans_test.go` with:

```go
func TestLsCmdEmitsPipe(t *testing.T) {
	setupEmptyDB(t)
	mustRun := func(c interface{ Run() error }) {
		t.Helper()
		if err := c.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	mustRun(&AddCmd{Title: strPtr("A"), URLs: sliceStrPtr([]string{"https://a.example.com/feed"}), Parsers: sliceStrPtr([]string{"#sanitize"})})

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&LsCmd{Format: "json"}).Run(); err != nil {
		t.Fatalf("LsCmd: %v", err)
	}
	if !strings.Contains(out.String(), `"pipe":["#sanitize"]`) {
		t.Errorf("ls output missing pipe field: %s", out.String())
	}
}

func TestLsCmdFiltersByTag(t *testing.T) {
	setupEmptyDB(t)
	mustRun := func(c interface{ Run() error }) {
		t.Helper()
		if err := c.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
	}
	mustRun(&AddCmd{Title: strPtr("A"), URLs: sliceStrPtr([]string{"https://a.example.com/feed"}), Tag: strPtr("tech")})
	mustRun(&AddCmd{Title: strPtr("B"), URLs: sliceStrPtr([]string{"https://b.example.com/feed"}), Tag: strPtr("news")})

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&LsCmd{Format: "json", Tag: strPtr("tech")}).Run(); err != nil {
		t.Fatalf("LsCmd: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, `"title":"A"`) {
		t.Errorf("expected channel A in filtered output: %s", body)
	}
	if strings.Contains(body, `"title":"B"`) {
		t.Errorf("did not expect channel B in tech-filtered output: %s", body)
	}
}
```

Also add a `bytes` import at the top of `cmd_chans_test.go` if not present (alongside `strings`, `testing`).

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd backend && go test -run 'TestLsCmd' .`
Expected: COMPILE FAIL with `undefined: stdout`.

- [ ] **Step 3: Refactor `cmd_chans.go`**

In `backend/cmd_chans.go`, replace `printFormatted`, `printJSON`, and the inline-types-in-`LsCmd` with the following. Place the import for `io` and `os` if not already there, and add a package-level `stdout` var.

At the top of `cmd_chans.go` (just after the imports), add:

```go
// stdout is the destination for printFormatted. Tests substitute this to
// capture command output without spawning a subprocess.
var stdout io.Writer = os.Stdout
```

(Add `"io"` and `"os"` to the imports if missing.)

Replace `printFormatted` (lines 14–28) with:

```go
func printFormatted(format string, v any) error {
	var output []byte
	var err error
	switch format {
	case "yaml":
		output, err = yaml.Marshal(v)
	case "json":
		output, err = json.Marshal(v)
	}
	if err != nil {
		return fmt.Errorf("encoding %s: %w", format, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", output); err != nil {
		return err
	}
	return nil
}
```

(Delete the now-unused `printJSON` helper — grep confirms no other caller.)

Add shared view types (after `parseFeeds`):

```go
// channelView is the canonical JSON/YAML shape for channel records. Used
// by `chan ls`, `chan show`, `chan apply`, and `chan edit`. ID is a pointer
// so `apply` can distinguish "absent => create" from "id 0 => update".
type channelView struct {
	ID     *int       `json:"id,omitempty" yaml:"id,omitempty"`
	Title  string     `json:"title"        yaml:"title"`
	Feeds  []feedView `json:"feeds"        yaml:"feeds"`
	Tag    string     `json:"tag,omitempty" yaml:"tag,omitempty"`
	Pipe   []string   `json:"pipe,omitempty" yaml:"pipe,omitempty"`
	Ingest string     `json:"ingest,omitempty" yaml:"ingest,omitempty"`
}

type feedView struct {
	URL   string `json:"url" yaml:"url"`
	Error string `json:"error,omitempty" yaml:"error,omitempty"`
}

// viewOf builds an output channelView for a stored Channel.
func viewOf(ch *Channel) *channelView {
	feeds := make([]feedView, len(ch.Feeds))
	for i, f := range ch.Feeds {
		feeds[i] = feedView{URL: f.URL, Error: f.FetchError}
	}
	id := ch.id
	return &channelView{
		ID:     &id,
		Title:  ch.Title,
		Feeds:  feeds,
		Tag:    ch.Tag,
		Pipe:   append([]string(nil), ch.Pipeline...),
		Ingest: ch.Ingest,
	}
}
```

Replace `LsCmd.Run` (lines 213–252) with the version that uses `channelView`:

```go
func (o *LsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		out := make([]*channelView, 0, len(db.Channels()))
		for _, ch := range db.Channels() {
			if o.Tag != nil && ch.Tag != *o.Tag {
				continue
			}
			out = append(out, viewOf(ch))
		}
		sort.Slice(out, func(i, j int) bool {
			return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
		})
		return printFormatted(o.Format, out)
	})
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && go test ./...`
Expected: PASS — including the new `TestLsCmdEmitsPipe` and the updated `TestLsCmdFiltersByTag`.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go
git commit -m "refactor(chan): introduce channelView + testable printFormatted"
```

---

### Task 8: `chan show`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)
- Modify: [backend/main.go](backend/main.go)

- [ ] **Step 1: Write failing tests**

Append to `backend/cmd_chans_test.go`:

```go
func TestChanShowFound(t *testing.T) {
	setupChannelsTestDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&ShowCmd{ID: 0, Format: "json"}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, `"id":0`) {
		t.Errorf("missing id: %s", body)
	}
	if !strings.Contains(body, `"title":"Test"`) {
		t.Errorf("missing title: %s", body)
	}
	if !strings.Contains(body, `"url":"https://a.example.com/feed"`) {
		t.Errorf("missing feed url: %s", body)
	}
}

func TestChanShowMissing(t *testing.T) {
	setupChannelsTestDB(t)
	wantErr(t, (&ShowCmd{ID: 99, Format: "json"}).Run(), "not found")
}

func TestChanShowYAML(t *testing.T) {
	setupChannelsTestDB(t)
	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&ShowCmd{ID: 0, Format: "yaml"}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	body := out.String()
	if !strings.Contains(body, "title: Test") {
		t.Errorf("missing yaml title: %s", body)
	}
}
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd backend && go test -run 'TestChanShow' .`
Expected: COMPILE FAIL with `undefined: ShowCmd`.

- [ ] **Step 3: Implement `ShowCmd`**

Append to `backend/cmd_chans.go`:

```go
type ShowCmd struct {
	ID     int    `arg:"" help:"Channel id."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *ShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.ChannelByID(o.ID)
		if err != nil {
			return err
		}
		return printFormatted(o.Format, viewOf(ch))
	})
}
```

- [ ] **Step 4: Wire into Kong**

In `backend/main.go`, extend `ChannelGroup`:

```go
type ChannelGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to RSS."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing channel."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from channel(s)."`
	Ls     LsCmd     `cmd:"" help:"List channels."`
	Show   ShowCmd   `cmd:"" help:"Print one channel's record."`
	Import ImportCmd `cmd:"" help:"Import opml channels file."`
}
```

- [ ] **Step 5: Run tests**

Run: `cd backend && go test -run 'TestChanShow' .`
Expected: PASS for all three tests.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go backend/main.go
git commit -m "feat(chan): add 'chan show ID' single-channel inspection"
```

---

### Task 9: `chan apply`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)
- Modify: [backend/main.go](backend/main.go)

Supports both single-object and array inputs, both create (id absent) and update (id present + channel exists), with whole-input atomic commit.

- [ ] **Step 1: Write failing tests**

Append to `backend/cmd_chans_test.go`:

```go
// applyFromString runs ApplyCmd against an in-memory JSON payload.
func applyFromString(t *testing.T, json string) error {
	t.Helper()
	cmd := &ApplyCmd{}
	cmd.in = strings.NewReader(json)
	return cmd.Run()
}

func TestChanApplySingleCreate(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{"title":"NewCh","feeds":[{"url":"https://x.example.com/feed"}],"tag":"t"}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	db := reopenDB(t)
	if len(db.Channels()) != 1 {
		t.Fatalf("Channels len = %d, want 1", len(db.Channels()))
	}
	ch := db.Channels()[0]
	if ch.Title != "NewCh" || ch.Tag != "t" {
		t.Errorf("unexpected channel: %+v", ch)
	}
}

func TestChanApplySingleUpdate(t *testing.T) {
	setupChannelsTestDB(t)
	err := applyFromString(t, `{"id":0,"title":"Renamed","feeds":[{"url":"https://a.example.com/feed"},{"url":"https://b.example.com/feed"}]}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Title != "Renamed" {
		t.Errorf("Title = %q, want Renamed", ch.Title)
	}
}

func TestChanApplyPreservesFeedState(t *testing.T) {
	setupChannelsTestDB(t)
	err := applyFromString(t, `{"id":0,"title":"Test","feeds":[{"url":"https://a.example.com/feed"},{"url":"https://c.example.com/feed"}]}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("kept feed state lost: ETag = %q", ch.Feeds[0].ETag)
	}
	if ch.Feeds[1].URL != "https://c.example.com/feed" || ch.Feeds[1].ETag != "" {
		t.Errorf("new feed not fresh: %+v", ch.Feeds[1])
	}
}

func TestChanApplyArray(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `[
		{"title":"A","feeds":[{"url":"https://a.example.com/feed"}]},
		{"title":"B","feeds":[{"url":"https://b.example.com/feed"}]}
	]`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := len(reopenDB(t).Channels()); got != 2 {
		t.Errorf("Channels len = %d, want 2", got)
	}
}

func TestChanApplyAtomicRollback(t *testing.T) {
	setupEmptyDB(t)
	// Second item missing title -> whole input must reject without writes.
	err := applyFromString(t, `[
		{"title":"A","feeds":[{"url":"https://a.example.com/feed"}]},
		{"feeds":[{"url":"https://b.example.com/feed"}]}
	]`)
	if err == nil {
		t.Fatal("expected error")
	}
	if got := len(reopenDB(t).Channels()); got != 0 {
		t.Errorf("Channels len = %d, want 0 (rollback)", got)
	}
}

func TestChanApplyIdMissingErrors(t *testing.T) {
	setupChannelsTestDB(t)
	err := applyFromString(t, `{"id":99,"title":"x","feeds":[{"url":"https://x.example.com/feed"}]}`)
	wantErr(t, err, "not found")
}

func TestChanApplyInvalidJSON(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{not json`)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestChanApplyCreateMissingFeeds(t *testing.T) {
	setupEmptyDB(t)
	err := applyFromString(t, `{"title":"X"}`)
	wantErr(t, err, "feeds required")
}

func TestChanApplyIgnoresReadOnlyFields(t *testing.T) {
	setupChannelsTestDB(t)
	// Input includes "etag" on a feed; stored ETag must NOT be overwritten by
	// the input value (apply ignores internal fields).
	err := applyFromString(t, `{"id":0,"title":"Test","feeds":[
		{"url":"https://a.example.com/feed","etag":"bogus-from-input"},
		{"url":"https://b.example.com/feed"}
	]}`)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("apply leaked input etag into stored state: %q", ch.Feeds[0].ETag)
	}
}
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `cd backend && go test -run 'TestChanApply' .`
Expected: COMPILE FAIL with `undefined: ApplyCmd`.

- [ ] **Step 3: Implement `ApplyCmd`**

Append to `backend/cmd_chans.go`. (Add `"io"` to imports if missing — it's already added in Task 7.)

```go
type ApplyCmd struct {
	File string `short:"f" type:"path" help:"Read JSON from PATH instead of stdin."`

	in io.Reader // test seam; defaults to os.Stdin
}

func (o *ApplyCmd) Run() error {
	src := o.in
	if src == nil {
		if o.File == "" || o.File == "-" {
			src = os.Stdin
		} else {
			f, err := os.Open(o.File)
			if err != nil {
				return fmt.Errorf("open %s: %w", o.File, err)
			}
			defer f.Close()
			src = f
		}
	}

	data, err := io.ReadAll(src)
	if err != nil {
		return fmt.Errorf("read input: %w", err)
	}

	views, err := parseApplyInput(data)
	if err != nil {
		return err
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		// Validate everything up-front (no partial writes).
		type pending struct {
			view *channelView
			ch   *Channel // existing channel for update; nil for create
		}
		ops := make([]pending, 0, len(views))
		for i, v := range views {
			if v.Title == "" {
				return fmt.Errorf("channel #%d: title required", i)
			}
			if len(v.Feeds) == 0 {
				return fmt.Errorf("channel #%d: feeds required", i)
			}
			if v.ID == nil {
				ops = append(ops, pending{view: v})
				continue
			}
			ch, err := db.ChannelByID(*v.ID)
			if err != nil {
				return err
			}
			ops = append(ops, pending{view: v, ch: ch})
		}

		// Apply.
		for _, op := range ops {
			urls := make([]string, len(op.view.Feeds))
			for i, f := range op.view.Feeds {
				urls[i] = f.URL
			}
			var prevFeeds []*Feed
			if op.ch != nil {
				prevFeeds = op.ch.Feeds
			}
			feeds, err := parseFeeds(urls, prevFeeds)
			if err != nil {
				return err
			}

			if op.ch == nil {
				ch := &Channel{
					Title:    op.view.Title,
					Feeds:    feeds,
					Tag:      op.view.Tag,
					Pipeline: append([]string(nil), op.view.Pipe...),
					Ingest:   op.view.Ingest,
				}
				if err := db.AddChannel(ch); err != nil {
					return err
				}
			} else {
				op.ch.Title = op.view.Title
				op.ch.Feeds = feeds
				op.ch.Tag = op.view.Tag
				op.ch.Pipeline = append([]string(nil), op.view.Pipe...)
				op.ch.Ingest = op.view.Ingest
			}
		}
		return db.Commit(ctx)
	})
}

// parseApplyInput accepts either a single channelView or an array.
// Auto-detect on the first non-whitespace byte.
func parseApplyInput(data []byte) ([]*channelView, error) {
	trim := bytes.TrimLeft(data, " \t\r\n")
	if len(trim) == 0 {
		return nil, fmt.Errorf("input must be a channel object or array of channel objects")
	}
	if trim[0] == '[' {
		var views []*channelView
		if err := json.Unmarshal(data, &views); err != nil {
			return nil, fmt.Errorf("decode array: %w", err)
		}
		return views, nil
	}
	if trim[0] == '{' {
		var view channelView
		if err := json.Unmarshal(data, &view); err != nil {
			return nil, fmt.Errorf("decode object: %w", err)
		}
		return []*channelView{&view}, nil
	}
	return nil, fmt.Errorf("input must be a channel object or array of channel objects")
}
```

Add `"bytes"` to the imports of `cmd_chans.go` if missing.

- [ ] **Step 4: Wire into Kong**

In `backend/main.go`, extend `ChannelGroup`:

```go
type ChannelGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to RSS."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing channel."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from channel(s)."`
	Ls     LsCmd     `cmd:"" help:"List channels."`
	Show   ShowCmd   `cmd:"" help:"Print one channel's record."`
	Apply  ApplyCmd  `cmd:"" help:"Upsert channels from JSON (object or array)."`
	Import ImportCmd `cmd:"" help:"Import opml channels file."`
}
```

- [ ] **Step 5: Run tests**

Run: `cd backend && go test -run 'TestChanApply' .`
Expected: PASS for all 9 tests.

Also: `cd backend && go test ./...`
Expected: PASS overall.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go backend/main.go
git commit -m "feat(chan): add 'chan apply' JSON upsert (single + array)"
```

---

### Task 10: `chan edit`

**Files:**
- Modify: [backend/cmd_chans.go](backend/cmd_chans.go)
- Modify: [backend/cmd_chans_test.go](backend/cmd_chans_test.go)
- Modify: [backend/main.go](backend/main.go)

- [ ] **Step 1: Write the `$EDITOR` test harness helper**

At the bottom of `backend/cmd_chans_test.go`, add:

```go
// writeEditorScript writes a /bin/sh script to a tempfile, chmods it +x, and
// returns its path. The script body receives the JSON tempfile as $1.
// Tests then point $EDITOR (or $VISUAL) at this path.
func writeEditorScript(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := dir + "/editor.sh"
	content := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write editor script: %v", err)
	}
	return path
}
```

Add `"os"` to imports if not already present (Task 9 already adds it via cmd_chans.go transitive but tests import their own).

- [ ] **Step 2: Write failing tests**

Append to `backend/cmd_chans_test.go`:

```go
func TestChanEditApplies(t *testing.T) {
	setupChannelsTestDB(t)
	// Editor: rewrite title to "Renamed", keep feeds and id intact.
	script := writeEditorScript(t, `cat > "$1" <<'EOF'
{"id":0,"title":"Renamed","feeds":[{"url":"https://a.example.com/feed"},{"url":"https://b.example.com/feed"}]}
EOF`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	if err := (&EditCmd{ID: 0}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	ch := reopenDB(t).Channels()[0]
	if ch.Title != "Renamed" {
		t.Errorf("Title = %q, want Renamed", ch.Title)
	}
	if ch.Feeds[0].ETag != "etag-a" {
		t.Errorf("feed state lost: %q", ch.Feeds[0].ETag)
	}
}

func TestChanEditNoChangeNoOp(t *testing.T) {
	setupChannelsTestDB(t)
	// Editor: do nothing — leave the file exactly as written.
	script := writeEditorScript(t, `: # no-op`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	// Pre-state.
	before := reopenDB(t).Channels()[0].Title

	if err := (&EditCmd{ID: 0}).Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := reopenDB(t).Channels()[0].Title; got != before {
		t.Errorf("title changed unexpectedly: %q -> %q", before, got)
	}
}

func TestChanEditIdChangedErrors(t *testing.T) {
	setupChannelsTestDB(t)
	script := writeEditorScript(t, `cat > "$1" <<'EOF'
{"id":7,"title":"Hijack","feeds":[{"url":"https://a.example.com/feed"}]}
EOF`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	wantErr(t, err, "id from 0 to 7")
	if reopenDB(t).Channels()[0].Title == "Hijack" {
		t.Errorf("hijacked title was applied")
	}
}

func TestChanEditInvalidJsonErrors(t *testing.T) {
	setupChannelsTestDB(t)
	script := writeEditorScript(t, `printf 'not json' > "$1"`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "JSON") && !strings.Contains(err.Error(), "json") {
		t.Errorf("error should mention JSON: %v", err)
	}
}

func TestChanEditEditorNonZeroExit(t *testing.T) {
	setupChannelsTestDB(t)
	script := writeEditorScript(t, `exit 42`)
	t.Setenv("EDITOR", script)
	t.Setenv("VISUAL", "")

	err := (&EditCmd{ID: 0}).Run()
	wantErr(t, err, "editor exited")
	// And no DB write.
	if reopenDB(t).Channels()[0].Title != "Test" {
		t.Errorf("Title unexpectedly changed despite editor failure")
	}
}

func TestChanEditChannelNotFound(t *testing.T) {
	setupChannelsTestDB(t)
	t.Setenv("EDITOR", writeEditorScript(t, `:`))
	t.Setenv("VISUAL", "")
	wantErr(t, (&EditCmd{ID: 99}).Run(), "not found")
}
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `cd backend && go test -run 'TestChanEdit' .`
Expected: COMPILE FAIL with `undefined: EditCmd`.

- [ ] **Step 4: Implement `EditCmd`**

Append to `backend/cmd_chans.go`. Add `"os/exec"` to the imports.

```go
type EditCmd struct {
	ID int `arg:"" help:"Channel id to edit."`
}

func (o *EditCmd) Run() error {
	editor := resolveEditor()
	if editor == "" {
		return fmt.Errorf("no editor found ($VISUAL, $EDITOR, vi)")
	}

	// 1. Load + serialize to a tempfile.
	view, err := loadChannelView(o.ID)
	if err != nil {
		return err
	}
	original, err := json.MarshalIndent(view, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal channel: %w", err)
	}

	tmp, err := os.CreateTemp("", fmt.Sprintf("srr-chan-%d-*.json", o.ID))
	if err != nil {
		return fmt.Errorf("create tempfile: %w", err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(original); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write tempfile: %w", err)
	}
	tmp.Close()

	// 2. Spawn editor.
	cmd := exec.Command(editor, tmpPath)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("editor exited with status %v (tempfile: %s): %w", cmd.ProcessState, tmpPath, err)
	}

	// 3. Re-read and check for changes.
	edited, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("read edited file %s: %w", tmpPath, err)
	}
	if bytes.Equal(edited, original) {
		os.Remove(tmpPath)
		return nil
	}

	// 4. Parse + validate id.
	var newView channelView
	if err := json.Unmarshal(edited, &newView); err != nil {
		return fmt.Errorf("invalid JSON in %s: %w", tmpPath, err)
	}
	if newView.ID == nil || *newView.ID != o.ID {
		got := -1
		if newView.ID != nil {
			got = *newView.ID
		}
		return fmt.Errorf("edited document changed id from %d to %d; refusing to apply (tempfile: %s)", o.ID, got, tmpPath)
	}

	// 5. Apply via ApplyCmd's path.
	apply := &ApplyCmd{}
	apply.in = bytes.NewReader(edited)
	if err := apply.Run(); err != nil {
		return err
	}
	os.Remove(tmpPath)
	return nil
}

// loadChannelView reads the DB unlocked (read-only) and returns the
// channelView for ID. The DB lock for the apply step is acquired separately
// inside ApplyCmd.Run.
func loadChannelView(id int) (*channelView, error) {
	var view *channelView
	err := withDB(false, func(_ context.Context, db *DB) error {
		ch, err := db.ChannelByID(id)
		if err != nil {
			return err
		}
		view = viewOf(ch)
		return nil
	})
	return view, err
}

// resolveEditor returns the first non-empty of $VISUAL, $EDITOR, then "vi".
func resolveEditor() string {
	for _, env := range []string{"VISUAL", "EDITOR"} {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	if _, err := exec.LookPath("vi"); err == nil {
		return "vi"
	}
	return ""
}
```

- [ ] **Step 5: Wire into Kong**

In `backend/main.go`, extend `ChannelGroup` (final version):

```go
type ChannelGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to RSS."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing channel."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from channel(s)."`
	Ls     LsCmd     `cmd:"" help:"List channels."`
	Show   ShowCmd   `cmd:"" help:"Print one channel's record."`
	Edit   EditCmd   `cmd:"" help:"Open a channel record in $EDITOR and apply on save."`
	Apply  ApplyCmd  `cmd:"" help:"Upsert channels from JSON (object or array)."`
	Import ImportCmd `cmd:"" help:"Import opml channels file."`
}
```

- [ ] **Step 6: Run tests**

Run: `cd backend && go test -run 'TestChanEdit' .`
Expected: PASS for all 6 tests.

Also: `cd backend && go test ./...`
Expected: PASS overall.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_chans.go backend/cmd_chans_test.go backend/main.go
git commit -m "feat(chan): add 'chan edit' \$EDITOR-driven channel editor"
```

---

## Phase 4 — Docs

### Task 11: Update `backend/CLAUDE.md`

**Files:**
- Modify: [backend/CLAUDE.md](backend/CLAUDE.md)

- [ ] **Step 1: Update the `cmd_chans.go` line under Architecture**

In `backend/CLAUDE.md`, replace the bullet that starts with `**`cmd_chans.go`**` with:

```markdown
- **`cmd_chans.go`** — `AddCmd` (`srr chan add`, strict-create; flags `-t/--title`, `-u/--url` (repeatable), `-g/--tag`, `-p/--parsers`, `-i/--ingest`), `UpdCmd` (`srr chan upd ID`, channel-level fields plus `-u/--url` (REPLACE), `--add-url` (idempotent APPEND), `--rm-url` (strict REMOVE); the three URL flags are mutually exclusive), `RmCmd` (`srr chan rm`), `LsCmd` (`srr chan ls`, filter by `-g/--tag`, yaml/json output), `ShowCmd` (`srr chan show ID`), `ApplyCmd` (`srr chan apply` reads channel JSON from `--file PATH` or stdin; accepts a single object or an array; whole-input atomic; create when `id` absent, full-replace update when `id` present, error if `id` references a missing channel), `EditCmd` (`srr chan edit ID` opens `$VISUAL`/`$EDITOR`/`vi` on the channel JSON; no-change is a no-op; id changes refused; tempfile preserved on parse error). Per-URL state (`ETag`, `Watermark`, `BoundaryGUIDs`) is preserved across `chan upd -u …`, `chan upd --add-url …`, `chan apply` updates, and `chan edit` by URL match. Empty-string convention on `-t`/`-g`/`-p`/`-i` clears the field where allowed (title cannot be cleared).
```

- [ ] **Step 2: Update the command-list line under `main.go`**

In `backend/CLAUDE.md`, replace the `main.go` bullet's command-list portion (today's `chan` line listing `add, rm, add-feed, rm-feed, ls, import`) with:

```markdown
Command groups: `chan` (alias `ch`): `add`, `upd`, `rm`, `ls`, `show`, `edit`, `apply`, `import`; `art` (alias `a`): `fetch`, `ls`; `preview` (alias `p`); `config` (alias `c`); `inspect` (alias `i`); `version`.
```

- [ ] **Step 3: Update the `channel.go` bullet**

In `backend/CLAUDE.md`, replace the `channel.go` bullet with:

```markdown
- **`channel.go`** — `Channel` (Title, Tag, Pipeline, `Ingest`, `Feeds []*Feed`) and `Feed` (URL, ETag `etag`, LastModified `last_modified`, Watermark `wm`, BoundaryGUIDs `bg`, FetchError `ferr`). `Channel.Fetch` iterates feeds sequentially, sharing the buffer pool slot; per-feed errors record into `Feed.FetchError` while items from successful feeds still commit. Pure type + orchestration; per-feed HTTP/dedup logic lives in `feed.go`.
```

(Removes the now-gone `Ingest` field on `Feed`.)

- [ ] **Step 4: Update the Ingest precedence paragraph under `Ingest (ingest/)`**

In `backend/CLAUDE.md`, replace the precedence sentence (currently "Selection precedence per feed: `Feed.Ingest` (most specific) > `Channel.Ingest` > `Globals.DefaultIngest` …") with:

```markdown
Selection precedence per channel: `Channel.Ingest` (most specific) > `Globals.DefaultIngest` (`--default-ingest` / `SRR_INGEST` / YAML `default-ingest`) > built-in `#rss`. Empty strings fall through; persistence uses `omitempty`.
```

- [ ] **Step 5: Update the `main.go` (ingest) bullet's `Select` signature**

In `backend/CLAUDE.md`, in the bullet under `Ingest (ingest/)` that documents `main.go`, replace `Select(feed, channel, global) string precedence helper` with:

```markdown
`Select(channel, global) string` precedence helper
```

- [ ] **Step 6: Update the `feed.go` bullet**

In `backend/CLAUDE.md`, replace `feed_fetch.go` references with `feed.go` if any remain, and update the `pickIngest` description. The relevant bullet should now read (starting "**`feed.go`**"):

```markdown
- **`feed.go`** — `Feed.fetch` selects an ingest-strategy name via `pickIngest(*Channel)` (`ingest.Select` plus a nil-globals guard), dispatches I/O+parse through the shared `*ingest.Fetcher` engine, then applies the dedup/watermark/pipeline path on the returned `ingest.Result.Items`. Dedup model per feed: `Watermark` is the max published unix-second ever seen and `BoundaryGUIDs` is the FNV-32a hash array used for dedup. Repopulated each non-empty fetch from the current response (no carry-over) so its size stays bounded by what the publisher currently exposes; a `NotModified` result or a non-modified response with zero items preserves prior `Watermark`/`BoundaryGUIDs` so the dedup state survives a transient empty channel. An item is new iff its GUID isn't in the prior fetch's `BoundaryGUIDs` AND (`pub == 0` OR `pub >= Watermark`). Item `pub` is clamped to `fetchedAt` so a publisher CMS bug that ships a far-future date can't poison `Watermark`. Within-fetch dedup uses a per-GUID set checked first so duplicate items in one feed response are collapsed and can't pollute `Watermark`/`BoundaryGUIDs`. Trade-off: items at `Watermark` or dateless items that disappear from the feed for one fetch and reappear later are re-ingested as duplicates (snapshot semantics over carry-over).
```

(If `backend/CLAUDE.md` already says `feed.go` and the only delta is the `pickIngest` signature, just patch that signature.)

- [ ] **Step 7: Run full verification**

Run: `make verify-be`
Expected: PASS — vet, build, tests all green.

- [ ] **Step 8: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "docs(backend): update CLAUDE.md for new chan CLI + Feed.Ingest removal"
```

---

## Self-Review Checklist

Run before declaring the plan complete.

1. **Spec coverage:**
   - Goals: de-overload `chan add` ✅ (Task 3), kill `add-feed`/`rm-feed` ✅ (Tasks 5+6), `chan show`/`apply`/`edit` ✅ (Tasks 8/9/10), drop `Feed.Ingest` ✅ (Tasks 1+2), state-preserving feed edits ✅ (Tasks 5 + 9).
   - Non-goals: no force-refetch, no URL rename, no deprecation aliases, no `feed` top-level group, no frontend changes — none introduced.
   - Error table from the spec: every entry has either a renamed existing test or a new test covering it (`TestChanUpdRequiresFieldFlag`, `TestChanUpdMutexUrlFlags`, `TestChanUpdRmURLEmptyingFeedListRejected`, `TestChanApplyCreateMissingFeeds`, `TestChanApplyIdMissingErrors`, `TestChanApplyInvalidJSON`, `TestChanEditEditorNonZeroExit`, `TestChanEditIdChangedErrors`, `TestChanEditInvalidJsonErrors`).
   - File-layout table: all files in scope (`channel.go`, `ingest/main.go`, `feed.go`, `cmd_preview.go`, `cmd_chans.go`, `cmd_chans_test.go`, `feed_test.go`, `main.go`, `backend/CLAUDE.md`) appear in at least one task.

2. **Placeholder scan:** No "TBD", "TODO later", "add error handling", "similar to Task N" — every code change shows the exact code, every command shows expected output.

3. **Type consistency:**
   - `channelView.ID *int`, `Feeds []feedView`, `Pipe []string` — same names used across `viewOf`, `LsCmd`, `ShowCmd`, `ApplyCmd`, `EditCmd`. ✅
   - `UpdCmd.URLs` / `AddURLs` / `RmURLs` named identically in struct, in tests, and in `Run`. ✅
   - `parseFeeds(urls, prev)` signature used identically in `AddCmd`, `UpdCmd` (replace branch), and `ApplyCmd`. ✅
   - `viewOf`, `loadChannelView`, `parseApplyInput`, `appendURLs`, `removeURLs`, `resolveEditor` — each defined once, called consistently. ✅
   - `stdout` package var used in `printFormatted` and the `ls`/`show` tests. ✅
