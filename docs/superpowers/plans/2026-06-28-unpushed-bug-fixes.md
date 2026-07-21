# Unpushed-Commit Bug Fixes & Simplifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Part A (Tasks 1–11):** Fix the 12 distinct bugs the `find-bugs-unpushed` workflow confirmed across the unpushed range `origin/main..HEAD` (the `srr serve` admin GUI feature stack + reader changes), in priority order, each behind a regression test where a harness exists.
- **Part B (Tasks S1–S8):** Apply the 28 simplifications the `find-simplifications-unpushed` workflow confirmed over the same range — behavior-preserving cleanups of complexity those same commits introduced or made redundant. **Part A lands first** (Part B must keep Part A's new regression tests green, and several items touch the same files).

**Architecture:** Each bug is independent. Backend Go fixes are TDD'd against the existing `*_test.go` harness (`setupTestDB`, `doReq`, `seedFeed`, `newMux`); frontend TS fixes against vitest/jsdom (`app.test.ts`, `nav.test.ts`). The `backend/webui/*.js` admin UI has **no JS test harness** (it ships as a `//go:embed` static asset), so those two fixes are code-only, gated by `make build-be` + manual browser check. Nothing here changes the writer↔reader data contract or `format.gen.ts`.

**Tech Stack:** Go 1.x (backend), TypeScript + Parcel + vitest/jsdom (frontend), vanilla JS (webui).

**Source of findings:** `/tmp/claude-1000/-home-gllera-ws-srr/dcd2b8dd-960b-4569-943b-b7f60758486a/tasks/wmeeqswsr.output` (`.result.confirmed`). Run from repo root `/home/gllera/ws/srr`. Backend commands run in `backend/`; frontend in `frontend/`.

---

## File Structure (Part A — bug fixes)

> Part B (simplifications) file map is tabled in the **Part B** section below.

| File | Change | Task |
|---|---|---|
| `backend/cmd_syndicate.go` | `removeOutFeed` rejects invalid names; add `outContentType` helper | 1, 5 |
| `backend/serve_syndicate_test.go` | path-traversal guard test | 1 |
| `backend/serve_feeds.go` | `saveFeed` preserves stored `NoTitle` on update; fix stale comment | 2 |
| `backend/serve_feeds_test.go` | serve-update preserves-NoTitle test | 2 |
| `backend/webui/app.js` | preview rendered in a sandboxed iframe; banner timer tracked/cleared | 3, 9 |
| `backend/serve_tools.go` | `handleImport` sets `tagOverride` from `?tag` | 4 |
| `backend/serve_tools_test.go` | import-with-tag-override test | 4 |
| `backend/db_out.go` | pass per-format `ObjectMeta`; add `audio` to `outAssetAttrs` | 5, 7 |
| `backend/db_out_test.go` | audio-rewrite test | 7 |
| `backend/cmd_syndicate_test.go` | `outContentType` helper test | 5 |
| `backend/cmd_preview.go` | `renderPreview` closes idle conns | 8 |
| `backend/store/s3.go` | S3 "already exists" wraps `os.ErrExist` | 10 |
| `frontend/src/js/app.ts` | focus a visible reader element, not a hidden heading | 6 |
| `frontend/src/js/app.test.ts` | titleless/empty focus-target tests | 6 |
| `frontend/src/js/nav.ts` | `applyFilter` keeps a known-but-empty token scoped | 11 |
| `frontend/src/js/nav.test.ts` | empty-feed-reload scope test | 11 |

---

## Task 1: Syndicate DELETE path traversal (HIGH, security)

`removeOutFeed` (shared by `DELETE /api/syndicate/{name}` and `srr syndicate rm`) never validates the name, while `setOutFeed` does. A name like `../../victim` flows into `db.Rm("out/../../victim.rss")`, which `filepath.Join` resolves outside the store root — silent arbitrary `.rss/.json` deletion.

**Files:**
- Modify: `backend/cmd_syndicate.go:124` (`removeOutFeed`)
- Test: `backend/serve_syndicate_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/serve_syndicate_test.go`:

```go
func TestRemoveOutFeedRejectsBadName(t *testing.T) {
	db, _, _ := setupTestDB(t)
	for _, name := range []string{"../../victim", "..", ".", "a/b", "out/../x"} {
		if err := removeOutFeed(ctx, db, name); err == nil {
			t.Errorf("removeOutFeed(%q) = nil, want error (path-traversal guard)", name)
		}
	}
	// A valid name still works (no false positive).
	if err := removeOutFeed(ctx, db, "mine"); err != nil {
		t.Errorf("removeOutFeed(%q) = %v, want nil", "mine", err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test -run TestRemoveOutFeedRejectsBadName .`
Expected: FAIL — `removeOutFeed("../../victim") = nil, want error`.

- [ ] **Step 3: Add the validation guard**

In `backend/cmd_syndicate.go`, at the top of `removeOutFeed` (currently line 124), insert the name check (mirrors `setOutFeed`):

```go
func removeOutFeed(ctx context.Context, db *DB, name string) error {
	if !validOutName(name) {
		return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", name)
	}
	var format string
	out := db.core.Out[:0]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test -run TestRemoveOutFeedRejectsBadName .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_syndicate.go backend/serve_syndicate_test.go
git commit -m "fix(serve): validate syndication name in removeOutFeed (DELETE path traversal)"
```

---

## Task 2: Titleless flag clobbered on serve feed save (HIGH)

The spec scopes `no_title` setting to the CLI (`feed apply`/`edit`) — the serve GUI must **preserve** it. But `saveFeed` → `writeFeedView` does `ch.NoTitle = v.NoTitle`, and the GUI PUT body omits `no_title`, so it decodes to `false` and every GUI edit silently un-titles the feed. `saveFeed` is serve-only (the CLI `apply` path uses `writeFeedView` directly, not `saveFeed`), so we fix it there without touching CLI full-replace semantics.

**Files:**
- Modify: `backend/serve_feeds.go:98` (`saveFeed`), `:12-14` (stale comment)
- Test: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/serve_feeds_test.go`:

```go
// A GUI feed save (PUT body without no_title) must not clobber a feed's stored
// titleless flag — setting it is scoped to the CLI (feed apply/edit).
func TestServeFeedUpdatePreservesNoTitle(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Chan", URL: "https://t.example.com/feed", NoTitle: true})

	// The exact body the webui edit modal sends: title/url/tag/recipe, no no_title.
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0",
		`{"title":"Chan renamed","url":"https://t.example.com/feed","tag":"news"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}

	ch, err := db.FeedByID(0)
	if err != nil {
		t.Fatalf("FeedByID: %v", err)
	}
	if !ch.NoTitle {
		t.Errorf("NoTitle = false after GUI save, want true (must be preserved)")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test -run TestServeFeedUpdatePreservesNoTitle .`
Expected: FAIL — `NoTitle = false after GUI save, want true`.

- [ ] **Step 3: Preserve the stored flag on update**

In `backend/serve_feeds.go`, in `saveFeed`'s update branch (currently lines 112-118), set `v.NoTitle` from the loaded feed before `writeFeedView` runs:

```go
	} else {
		existing, err := db.FeedByID(*v.ID)
		if err != nil {
			return nil, err
		}
		ch = existing
		// Setting the titleless flag is scoped to the CLI (feed apply/edit); the
		// serve GUI edit form never carries no_title, so preserve the stored value
		// instead of letting writeFeedView clobber it to the JSON zero value.
		v.NoTitle = ch.NoTitle
	}
```

- [ ] **Step 4: Fix the now-accurate comment**

In `backend/serve_feeds.go`, update the `feedListView` doc comment (lines 12-14) so it no longer claims writes are title/url/tag/recipe-only:

```go
// feedListView is the read-only feed shape the GUI table consumes: the writable
// feedView fields plus server-owned health fields. Writes (POST/PUT) accept
// title/url/tag/recipe; no_title is preserved from the stored feed (its setting
// is scoped to the CLI feed apply/edit path).
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && go test -run 'TestServeFeedUpdatePreservesNoTitle|TestFeed' .`
Expected: PASS (new test plus the existing `TestFeedApplySetsNoTitle`/`TestFeedViewEmitsNoTitle`/`TestFeedListViewEmitsNoTitle` stay green — the CLI path is untouched).

- [ ] **Step 6: Commit**

```bash
git add backend/serve_feeds.go backend/serve_feeds_test.go
git commit -m "fix(serve): preserve feed NoTitle flag on GUI save (titleless clobber)"
```

---

## Task 3: Recipe-preview XSS on the admin origin (MEDIUM, security)

`previewPanel` injects `a.content` via `innerHTML` (the `el` helper's `html` key) on the privileged admin origin. A recipe whose pipe omits `#sanitize` yields unsanitized feed HTML, so `<img src=x onerror=…>` executes and can drive the same-origin mutating API. Render the preview in a sandboxed iframe (no `allow-scripts`) so feed-supplied markup can never execute.

**Files:**
- Modify: `backend/webui/app.js:467` (`previewPanel` content node)

No JS unit harness — gate on build + manual browser check.

- [ ] **Step 1: Render preview content in a sandboxed iframe**

In `backend/webui/app.js`, in `previewPanel`, replace the content `div` (line 467):

```js
        out.append(el("article", { class: "preview" },
          el("h4", {}, a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener" }, a.title) : a.title),
          el("iframe", {
            class: "preview-frame",
            // Empty sandbox = scripts, inline event handlers and javascript: URLs all
            // disabled, so a recipe that omits #sanitize can't run feed-supplied JS on
            // the admin origin. srcdoc renders the HTML inert.
            sandbox: "",
            srcdoc: a.content,
            style: "width:100%;height:16em;border:1px solid var(--line,#3a3a3a);border-radius:6px;background:#fff",
          })));
```

- [ ] **Step 2: Build to embed the updated asset**

Run: `cd backend && go build -o /dev/null . && cd .. && make build-be`
Expected: builds cleanly (the `//go:embed webui` picks up the new `app.js`).

- [ ] **Step 3: Manual verification (note in commit body)**

Manually: `srr serve`, Recipes → Preview a recipe whose pipe is `#minify` (no `#sanitize`) against a feed with `<img src=x onerror="document.title='pwned'">`. Confirm the title does NOT change (script never runs) and the article body still renders inside the framed box.

- [ ] **Step 4: Commit**

```bash
git add backend/webui/app.js
git commit -m "fix(serve): render recipe preview in a sandboxed iframe (admin-origin XSS)"
```

---

## Task 4: GUI OPML import ignores `?tag` override (MEDIUM)

`handleImport` builds the `importWalker` without `tagOverride`, so `resolveTag` still runs and hard-errors (→ HTTP 400) on un-normalizable OPML folder names (e.g. a folder named `2024`), even when the caller supplied `?tag=`. The CLI sets `tagOverride: o.Tag != nil` precisely to skip that resolution.

**Files:**
- Modify: `backend/serve_tools.go:120` (`handleImport`)
- Test: `backend/serve_tools_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/serve_tools_test.go`:

```go
func TestHandleImportTagOverrideSkipsGroupResolution(t *testing.T) {
	setupTestDB(t)
	// A numeric-only folder name ("2024") makes resolveTag/normalizeGroupName error;
	// a ?tag= override must skip that resolution (the CLI -g does).
	opml := `<opml version="2.0"><body><outline text="2024">` +
		`<outline text="Alpha" type="rss" xmlUrl="https://a.example/feed"/></outline></body></opml>`
	rec := doReq(t, newMux(), "POST", "/api/import?tag=mytag&dry_run=1", opml)
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d, body %s", rec.Code, rec.Body.String())
	}
}
```

(`dry_run=1` avoids the networked subscribe-time probe so the test stays offline; the 400 fires during the walk, before dry-run branches, so it still reproduces the bug.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test -run TestHandleImportTagOverrideSkipsGroupResolution .`
Expected: FAIL — status `400` with a `numeric-only after normalization` error.

- [ ] **Step 3: Set tagOverride from the query param**

In `backend/serve_tools.go`, `handleImport` — read the `tag` presence before the walk and pass it to the walker (replace line 120):

```go
	iw := &importWalker{w: io.Discard, seen: map[string]bool{}, tagOverride: q.Has("tag")}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test -run TestHandleImportTagOverrideSkipsGroupResolution .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/serve_tools.go backend/serve_tools_test.go
git commit -m "fix(serve): honor ?tag override in OPML import (skip group-name resolution)"
```

---

## Task 5: S3 syndication feeds served as octet-stream (MEDIUM)

`syncOneOutFeed` writes `out/<name>.rss|json` with an empty `store.ObjectMeta{}`, so S3 stamps `Content-Type: application/octet-stream` (the default). External feed readers won't recognize a feed served as octet-stream. Pass the right type per format.

**Files:**
- Modify: `backend/cmd_syndicate.go` (add `outContentType` helper near `outFileKey:150`), `backend/db_out.go:184`
- Test: `backend/cmd_syndicate_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/cmd_syndicate_test.go`:

```go
func TestOutContentType(t *testing.T) {
	cases := map[string]string{
		"rss":  "application/rss+xml",
		"json": "application/feed+json",
		"":     "application/rss+xml", // default branch mirrors outFileKey
	}
	for format, want := range cases {
		if got := outContentType(OutFeed{Format: format}); got != want {
			t.Errorf("outContentType(%q) = %q, want %q", format, got, want)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test -run TestOutContentType .`
Expected: FAIL to compile — `undefined: outContentType`.

- [ ] **Step 3: Add the helper**

In `backend/cmd_syndicate.go`, after `outFileKey` (line 150-157), add:

```go
// outContentType returns the HTTP Content-Type for an OutFeed's output file, so
// S3-hosted syndication feeds (out/*.rss, out/*.json) are recognized by external
// readers rather than served as the application/octet-stream default.
func outContentType(o OutFeed) string {
	if o.Format == "json" {
		return "application/feed+json"
	}
	return "application/rss+xml"
}
```

- [ ] **Step 4: Pass it from syncOneOutFeed**

In `backend/db_out.go`, line 184, replace the empty meta:

```go
	if err := o.Backend.AtomicPut(ctx, key, &buf, store.ObjectMeta{ContentType: outContentType(of)}); err != nil {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test -run 'TestOutContentType|TestSyncOutFeeds' .`
Expected: PASS (helper test + the existing SyncOutFeeds tests, which write to a local store and ignore meta).

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_syndicate.go backend/db_out.go backend/cmd_syndicate_test.go
git commit -m "fix(syndicate): stamp Content-Type on out/* so S3 feeds aren't octet-stream"
```

---

## Task 6: Reader focus lands on a `display:none` heading (MEDIUM, a11y)

Both the titleless-feed render and the empty-reader render hide the `<h1 class="srr-title">` via CSS (`.srr-reader-titleless .srr-title-link` / `.srr-reader-empty .srr-title-row` → `display:none`), then call `el.title.focus()`. Focusing a `display:none` element is a no-op in real browsers, so keyboard/SR focus never enters the reader. Focus a visible element (`el.content`) in those two cases instead.

**Files:**
- Modify: `frontend/src/js/app.ts:326` (`render`), `:362` (`renderEmptyReader`)
- Test: `frontend/src/js/app.test.ts`

- [ ] **Step 1: Write the failing tests**

In `frontend/src/js/app.test.ts`, add to the existing `describe("reader titleless feeds …")` (line 306) and `describe("reader placeholder …")` (line 262) blocks. Mirror the existing `showFeed(...)` usage in those blocks; assert the focus target:

```ts
it("moves focus into the visible content, not the hidden heading", async () => {
   // feed.nt = true hides the <h1>; focus must land on .srr-content instead.
   await showFeed({ article: { f: 0, a: 0, p: 0, t: "T", l: "", c: "<p>body</p>" } })
   expect(document.activeElement).toBe(document.querySelector(".srr-content"))
})
```

(For the titleless block, set the feed's `nt` flag the same way that block's other tests do; for the placeholder block, use the `{ placeholder: true, … }` shape already used at lines 266/290 and assert the same `.srr-content` target.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/js/app.test.ts`
Expected: FAIL — `activeElement` is `.srr-title`, not `.srr-content`.

- [ ] **Step 3: Focus a visible element**

In `frontend/src/js/app.ts`, `render()` — replace line 326 (`el.title.focus()`):

```ts
   // A titleless feed hides the <h1>; focusing a display:none element is a no-op,
   // so move focus to the visible body instead to keep the reader region focused.
   el.content.tabIndex = -1
   ;(feed?.nt ? el.content : el.title).focus()
```

In `renderEmptyReader()` — replace line 362 (`el.title.focus()`):

```ts
   // The empty state hides the whole title row; focus the (visible) content host,
   // which carries the directed empty-state element.
   el.content.tabIndex = -1
   el.content.focus() // keep keyboard focus inside the reader region
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/js/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/app.ts frontend/src/js/app.test.ts
git commit -m "fix(reader): focus visible content when the heading is hidden (titleless/empty)"
```

---

## Task 7: Self-hosted `<audio>` not CDN-rewritten in syndication (LOW)

These commits added `<audio>` self-hosting (`mod.assetAttrs` gained `audio:{src}`), but `db_out.go`'s parallel `outAssetAttrs` (which absolutizes relative `assets/` refs in `out/*` content) was not updated, so syndicated audio keeps a relative path external readers can't resolve.

**Files:**
- Modify: `backend/db_out.go:356` (`outAssetAttrs`)
- Test: `backend/db_out_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/db_out_test.go`:

```go
func TestRewriteAssetURLsAudio(t *testing.T) {
	got, err := rewriteAssetURLs(`<audio src="assets/ab/0123456789abcdef.mp3"></audio>`, "https://cdn.example.com")
	if err != nil {
		t.Fatalf("rewriteAssetURLs: %v", err)
	}
	if !strings.Contains(got, "https://cdn.example.com/assets/ab/0123456789abcdef.mp3") {
		t.Errorf("audio src not absolutized:\n%s", got)
	}
	if strings.Contains(got, `src="assets/`) {
		t.Errorf("relative audio src still present:\n%s", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test -run TestRewriteAssetURLsAudio .`
Expected: FAIL — relative `src="assets/` still present (`audio` not in `outAssetAttrs`).

- [ ] **Step 3: Add `audio` to outAssetAttrs**

In `backend/db_out.go`, extend the map (lines 356-360):

```go
var outAssetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
	"a":     {"href"},
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test -run 'TestRewriteAssetURLsAudio|TestSyncOutFeedsAssetRewrite' .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/db_out.go backend/db_out_test.go
git commit -m "fix(syndicate): rewrite self-hosted <audio> src to CDN URL in out feeds"
```

---

## Task 8: `/api/preview` leaks an HTTP transport per request (LOW)

`renderPreview` builds a fresh `newFetchClient(1)` (its own `SafeTransport` with a 90s idle pool) each call and never closes it. Harmless for the one-shot CLI, but `GET /api/preview` calls it per request on the long-lived serve process, accumulating idle sockets. `handleFetch` already guards this with `CloseIdleConnections()`.

**Files:**
- Modify: `backend/cmd_preview.go:74` (`renderPreview`)

No targeted unit test (socket-pool lifecycle); gate on build/vet + the existing preview tests.

- [ ] **Step 1: Close idle connections after the fetch**

In `backend/cmd_preview.go`, `renderPreview`, after line 74 (`client := newFetchClient(1)`):

```go
	client := newFetchClient(1)
	// One-shot per render; the serve process calls this per request, so reclaim
	// the transport's idle keep-alive sockets instead of leaking them ~90s each.
	defer client.CloseIdleConnections()
```

- [ ] **Step 2: Verify build + existing tests**

Run: `cd backend && go vet . && go test -run 'TestPreview|TestHandlePreview|TestRenderPreview' .`
Expected: PASS (no behavior change to outputs).

- [ ] **Step 3: Commit**

```bash
git add backend/cmd_preview.go
git commit -m "fix(serve): close renderPreview transport idle conns (per-request leak)"
```

---

## Task 9: Success-banner timer hides a later error banner (LOW)

`banner()` arms a 2.5s `setTimeout(() => b.hidden = true)` for every success but never tracks/cancels it. The single `#banner` element is shared, so a success banner's pending timer blindly hides whatever banner is showing at the 2.5s mark — including a subsequent error banner meant to persist.

**Files:**
- Modify: `backend/webui/app.js:47` (`banner`), `:54` (`clearBanner`)

No JS harness — gate on build + manual check.

- [ ] **Step 1: Track and clear the timer**

In `backend/webui/app.js`, replace `banner`/`clearBanner` (lines 47-54):

```js
let bannerTimer = 0;
function banner(msg, ok) {
  const b = document.getElementById("banner");
  clearTimeout(bannerTimer); // a prior success timer must not hide this banner
  b.textContent = msg;
  b.hidden = false;
  b.classList.toggle("ok", !!ok);
  if (ok) bannerTimer = setTimeout(() => (b.hidden = true), 2500);
}
function clearBanner() {
  clearTimeout(bannerTimer);
  document.getElementById("banner").hidden = true;
}
```

- [ ] **Step 2: Build + manual verification**

Run: `cd .. && make build-be`
Manually: trigger a success banner, then within 2.5s trigger an error (e.g. Save a feed with an empty URL); confirm the error banner stays visible past 2.5s.

- [ ] **Step 3: Commit**

```bash
git add backend/webui/app.js
git commit -m "fix(serve): cancel stale success-banner timer so it can't hide a later error"
```

---

## Task 10: Lock-contention 409 only works for the local store (LOW)

`writeErr`/`handleFetch` map store-lock contention to a friendly 409 by gating on `errors.Is(err, os.ErrExist)`. Local satisfies it (O_EXCL → EEXIST); S3 returns a bare `fmt.Errorf("key … already exists on s3")` with no `os.ErrExist` in the chain, so S3 deployments get a raw 400 instead. Wrap the S3 case so the check holds. (SFTP's `SSH_FX_FAILURE` mapping is deferred — see note.)

**Files:**
- Modify: `backend/store/s3.go:3` (imports), `:168` (`put`)

- [ ] **Step 1: Wrap the S3 "already exists" error with os.ErrExist**

In `backend/store/s3.go`, add `"os"` to the stdlib import block (lines 3-11, alphabetical):

```go
	"net/url"
	"os"
	"path"
```

Then change the precondition case (line 167-168):

```go
	case s3ErrPreconditionFailed:
		return fmt.Errorf("key %q already exists on s3: %w", key, os.ErrExist)
```

- [ ] **Step 2: Verify build + vet + store tests**

Run: `cd backend && go vet ./store/ && go test ./store/`
Expected: PASS (existing s3 tests unaffected; the wrap only adds an `errors.Is` target).

- [ ] **Step 3: Commit**

```bash
git add backend/store/s3.go
git commit -m "fix(store): S3 'already exists' wraps os.ErrExist so serve maps lock contention to 409"
```

> **Deferred (note, do not block):** SFTP's `OpenFile(O_EXCL)` collision surfaces as `SSH_FX_FAILURE`, which `pkg/sftp` does not map to `os.ErrExist`. Closing that gap means Stat-on-error classification in `SFTP.Put` — more involved, rarely the lock backend in practice, and out of scope for this fix pass. Track separately if SFTP serve deployments need the 409.

---

## Task 11: Empty feed/tag scope lost on reload/back (LOW)

`switchFilter` makes a known-but-empty feed/tag pickable (scopes the filter + shows the placeholder, persisting `#!<token>`). But the reload/back path `route()` → `applyFilter([token])` → `filter.set` clears an empty resolution to `[ALL]`, so the URL canonicalizes to `#` and the full list shows. Make `applyFilter` re-scope a known-but-empty token, symmetric with `switchFilter`, without touching `filter.set` (which `switchFilter` also calls).

**Files:**
- Modify: `frontend/src/js/nav.ts` (`applyFilter`)
- Test: `frontend/src/js/nav.test.ts`

- [ ] **Step 1: Write the failing test**

In `frontend/src/js/nav.test.ts`, using the suite's existing `setupIndex`/`makeFeed` helpers, add a test that seeds a **known empty** feed (`total_art: 0`) and a normal feed, then drives the reload entry point:

```ts
it("applyFilter keeps a known-but-empty feed scoped (reload of #!<id>)", () => {
   // feed 5 exists but has no articles; feed 9 has some.
   setupIndex([makeFeed({ id: 9, total_art: 3 })])
   data.db.feeds[5] = makeFeed({ id: 5, total_art: 0 })

   nav.applyFilter(["5"])
   expect(nav.filter.tokens).toEqual(["5"]) // not cleared to [ALL]
   expect(nav.filter.feeds.size).toBe(0)

   // A genuinely unknown token still falls back to [ALL].
   nav.applyFilter(["999"])
   expect(nav.filter.tokens).toEqual([])
})
```

(Adapt `makeFeed`/`setupIndex` to the exact mock shape used at the top of `nav.test.ts`; the assertions on `filter.tokens`/`filter.feeds` are the contract.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/js/nav.test.ts`
Expected: FAIL — after `applyFilter(["5"])`, `filter.tokens` is `[]` (cleared to `[ALL]`).

- [ ] **Step 3: Re-scope a known-but-empty token in applyFilter**

In `frontend/src/js/nav.ts`, replace `applyFilter`:

```ts
export function applyFilter(tokens: string[]): void {
   if (tokens.length === 0) {
      filter.clear()
      return
   }
   filter.set(tokens)
   // Symmetric with switchFilter: a known feed/tag that currently has zero
   // matching articles (an empty feed, pickable when read items are shown)
   // makes filter.set fall back to [ALL]. Re-scope it to itself so a reload/back
   // to `#!<token>` re-renders the empty-state placeholder under that scope
   // instead of silently showing [ALL]'s full list. A truly unknown/stale token
   // still falls back to [ALL].
   if (!filter.active && tokens.length === 1 && isKnownToken(tokens[0])) {
      filter.tokens = [tokens[0]]
      filter.feeds = new Map<number, number>()
   }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/js/nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/nav.ts frontend/src/js/nav.test.ts
git commit -m "fix(nav): keep a known-but-empty feed/tag scoped on reload (not [ALL])"
```

---

## Part B — Simplifications

**Source of findings:** the `find-simplifications-unpushed` workflow over `origin/main...HEAD` → `/tmp/claude-1000/-home-gllera-ws-srr/393fd68a-f674-425c-9f51-b160f7b59a47/tasks/wclcbrxv6.output` (`.result.proposals`, 32 confirmed → 28 after merges; rendered roadmap at `…/scratchpad/roadmap.md`). "Quick #N / Medium #N" refs below point back to that roadmap.

**Nature & gate:** these are **behavior-preserving refactors**, so — unlike Part A — there is no failing-test-first step. Each task's gate is the **existing** tests + build staying green: run the named package tests, then the global `make verify` at the end. None of these touch the idx/data/meta contract or `format.gen.ts`.

**Sequencing rules:**
1. **Do Part A (Tasks 1–11) first.** Part B must not regress the new tests, and Task S1 rewrites test readbacks.
2. Execute **S1 → S8 in order** — the order resolves intra-B dependencies (e.g. S1 decides which builders become single-caller before S2 inlines one).
3. **File overlaps with Part A** are flagged per task; apply the Part B edit *after* the corresponding Part A task so line numbers don't drift.

| Task | Roadmap items | Primary files | Gist |
|---|---|---|---|
| S1 | Medium #1 | `backend/cmd_serve.go`, `serve_feeds.go`, `serve_recipes.go`, `serve_syndicate.go`, `serve_tools.go` + their `_test.go`, `backend/CLAUDE.md` | remove the 6 GET read endpoints `/api/overview` superseded (**keep-or-remove decision**) |
| S2 | Quick #6 | `backend/serve_recipes.go`, `backend/CLAUDE.md` | inline `buildRecipeMap` |
| S3 | Quick #1 | `backend/cmd_fetch.go`, `serve_fetch.go`, `serve_fetch_test.go` | drop dead `runFetch` `filter` param |
| S4 | Quick #8, #11 | `backend/mod/main.go`, `backend/assets.go` | inline `RunCommand` wrapper; drop dead `timeout>0` branch |
| S5 | Quick #2, #4, #9 + Medium #4 | `backend/webui/app.js` | admin-console cleanups (snapshot mirror, `healthDot`, modal helpers) |
| S6 | Medium #6 (+Quick #18), Quick #19, #20 | `frontend/src/styles.css`, `backend/webui/app.css` | CSS dedup + dead-rule removal |
| S7 | Quick #7, #13, #14, #15, #21, #22 | `backend/serve_*_test.go`, `cmd_recipe_test.go`, `feed_test.go`, `frontend/src/js/app.test.ts` | test-helper dedup + dead-setup removal |
| S8 | Quick #3, #5, #10, #12, #16, #17 + Medium #2, #3, #5 | various (isolated) | independent leftovers |

---

## Task S1: Drop the 6 granular read endpoints superseded by `GET /api/overview` (Medium #1, M)

The same diff added `GET /api/overview` (feeds+tags+recipes+out+gen+fetched_at+total_art in one read) **and** six GET handlers the only client never calls: `listFeeds`, `getFeed`, `listTags` (`serve_feeds.go`), `listRecipes` (`serve_recipes.go`), `listSyndicate` (`serve_syndicate.go`), `getGen` (`serve_tools.go`). The webui reads everything from `/api/overview` (`app.js:144,173,616`) and re-fetches after mutations. ~83 handler LOC + 6 routes + ~83 test LOC + the drift-prevention indirection collapse to one read surface.

> **DECISION (do this first — it gates S2 and S7):** this removes a *documented* REST surface. Keep it only if a non-UI consumer is planned. If you'd rather keep the surface, do only the narrow confirmed slices (drop `getFeed`, drop `GET /api/gen`) and skip the rest of S1 — then S2 still applies.
> **Coordinate with Part A:** none of Part A's *new* tests read back via these GETs (Task 1 calls `removeOutFeed` directly; Task 2 reads via `db.FeedByID`; Task 4 checks status; Task 5 is a unit test), so they are unaffected. It's the **pre-existing** serve mutation tests that read back via a removed GET — those get rewritten in Step 2.

**Files:** `backend/cmd_serve.go` (routes 208,211,214,215,219,223); `serve_feeds.go:59-92,247-258`; `serve_recipes.go:18-29`; `serve_syndicate.go:8-21`; `serve_tools.go:52-63`; the matching `_test.go`; `backend/CLAUDE.md`.

- [ ] **Step 1: Delete the six handlers + their six `mux.HandleFunc` route lines** (`cmd_serve.go:208,211,214,215,219,223`).
- [ ] **Step 2: Fix the tests** — delete only the 5 pure-GET tests now redundant with `TestOverview` (`TestListFeeds`, `TestGetFeed`, `TestGetFeedNotFound`, `TestListTags`, `TestListRecipes`); **rewrite** (don't delete) the mutation tests that read back via a removed GET to read via `GET /api/overview` or a direct `withDB(...)`.
- [ ] **Step 3: Inline now-single-caller builders** — `buildFeedViews`/`buildTagCounts` become single-caller from `getOverview`; inline them (this subsumes S2's `buildRecipeMap` inline — do S2 here if convenient, or right after).
- [ ] **Step 4: Update docs** — drop the six endpoints from `backend/CLAUDE.md:32` (the serve endpoint list).
- [ ] **Step 5: Gate** — `cd backend && go vet . && go test .` (all serve tests green).
- [ ] **Step 6: Commit** — `git commit -m "refactor(serve): drop granular read endpoints superseded by /api/overview"`

---

## Task S2: Inline `buildRecipeMap` (Quick #6, S)

`buildRecipeMap` (`serve_recipes.go:8-16`) allocates+copies `db.core.Recipes` "for read-only JSON" on every overview/recipes request; read handlers never mutate it. After S1, `getOverview` is its lone caller.

**Files:** `backend/serve_recipes.go:8-16`; `backend/CLAUDE.md`.

- [ ] **Step 1:** Delete `buildRecipeMap`; in `listRecipes` (if it survived S1) and `getOverview` replace `buildRecipeMap(db)` → `db.core.Recipes`. Update the `backend/CLAUDE.md` `/api/overview` note that names the helper (doc-only).
- [ ] **Step 2: Gate** — `cd backend && go test -run 'TestOverview|TestRecipe' .`
- [ ] **Step 3: Commit** — `git commit -m "refactor(serve): inline buildRecipeMap (drop defensive copy for read-only JSON)"`

---

## Task S3: Drop the dead `filter` parameter from `runFetch` (Quick #1, S)

Commit `5370d3b1` made the webui "Fetch now" always pass `nil`, so every production caller (`cmd_fetch.go:60,63`, `serve_fetch.go:33`) passes nil; the param forces two duplicate guard branches (`155-157`, `257-259`), a stale 3-line comment, and a docstring that wrongly claims "the SSE handler passes a feed filter." The only non-nil caller is `TestRunFetchFilterExcludes`.

**Files:** `backend/cmd_fetch.go:101,155-157,252-264,60,63`; `serve_fetch.go:33`; `serve_fetch_test.go:58-79`.

- [ ] **Step 1:** Drop the `filter func(*Feed) bool` param from `runFetch`; delete the guard at `cmd_fetch.go:155-157` (keep `if ctx.Err() != nil { break }`) and `257-259`; trim the count-loop comment (252-254); update call sites `cmd_fetch.go:60/63` → `runFetch(ctx, client, nil)` and `serve_fetch.go:33` to drop the nil arg.
- [ ] **Step 2:** Rewrite the stale docstring (`cmd_fetch.go:97-100`) — e.g. "runFetch runs one fetch cycle over every feed, invoking onFeed (if non-nil) once per feed as it finishes; onFeed may run from worker goroutines, so callers must guard it."
- [ ] **Step 3:** Delete `TestRunFetchFilterExcludes` (`serve_fetch_test.go:58-79`) — its path is gone; `TestRunFetchAllAndProgress`/`TestFetchSSE` cover the surviving nil path.
- [ ] **Step 4: Gate** — `cd backend && go test -run 'TestRunFetch|TestFetchSSE' .`
- [ ] **Step 5: Commit** — `git commit -m "refactor(fetch): drop dead runFetch filter param + its branches/test"`

---

## Task S4: `RunCommand` collapse (Quick #8 then #11, S)

Two edits to `backend/mod/main.go`, both touching `RunCommandTimeout`'s doc — do in this order.

**Files:** `backend/mod/main.go:96-101,103-118`; `backend/assets.go:453,456`.

- [ ] **Step 1 (Quick #8 — inline the wrapper):** Delete `RunCommand` (`main.go:96-101`); change `runPeek` (`assets.go:456`) to `mod.RunCommandTimeout(ctx, mod.SubprocessTimeout(), argv[0], argv[1:]...)`. Fix the dangling doc reference at `assets.go:453` ("Shares mod.RunCommand's…") → `mod.RunCommandTimeout`, and drop the "instead of the shared SubprocessTimeout" clause in `RunCommandTimeout`'s doc (`main.go:103-110`).
- [ ] **Step 2 (Quick #11 — drop the dead `timeout>0` branch):** Body becomes `cctx, cancel := context.WithTimeout(ctx, timeout); defer cancel(); return runBounded(exec.CommandContext(cctx, name, args...))`. Delete only the doc sentence "A non-positive timeout applies no deadline beyond ctx." (`main.go:109-110`). **Keep the `assets.go:383-385` clamp** — it is what makes always-applying the deadline safe.
- [ ] **Step 3: Gate** — `cd backend && go vet ./mod/ . && go test -run 'TestRunCommand|TestPeek|TestAssetProcess' ./... `
- [ ] **Step 4: Commit** — `git commit -m "refactor(mod): inline RunCommand wrapper and drop dead timeout branch"`

---

## Task S5: Admin-console (`webui/app.js`) cleanups (Quick #2, #4, #9 + Medium #4, M)

Four cleanups in one pass on the embedded vanilla-JS UI. **No JS unit harness** → gate on `make build-be` + a manual click-through.

> **Coordinate with Part A:** Tasks 3 (preview iframe in `previewPanel`) and 9 (banner timer in `banner`/`clearBanner`) also edit `app.js`. Apply S5 **after** Tasks 3 & 9 so the line refs below hold; re-locate by symbol if they've shifted.

**Files:** `backend/webui/app.js`.

- [ ] **Step 1 (Quick #2 — drop the `feedsState` mirror):** Set `const feedsState = { search: "", tag: "" };` (line 181); delete the mirror copy (239-241) and the `renderFeeds` wrapper → `renderers.feeds = drawFeeds`. Repoint the six reads to `snapshot.*`: lines 209, 210, 257, 317, 327 → `snapshot.feeds`/`snapshot.tags`/…; 347 → `snapshot.recipes`. **Do NOT touch** lines 252/255/261 (`feedsState.search`/`feedsState.tag` — real UI state).
- [ ] **Step 2 (Quick #4 — drop `healthDot`'s dead error-title branch):** Remove the `suppressTitle` param and the always-discarded `f.error ? …` title branch (196-203); failing feeds keep `feedRow`'s richer tooltip/aria-label. Update call site `app.js:301` `healthDot(f, true)` → `healthDot(f)` (304 already bare).
- [ ] **Step 3 (Quick #9 — extract lazy-dialog creation):** Factor the repeated `if (!xDialog) { xDialog = el('dialog', …); document.body.append(xDialog); }` (337-340, 408-411, 512) into a `makeDialog(...)` helper (or `||=`).
- [ ] **Step 4 (Medium #4 — dedup the 3 modal save handlers):** Add `async function saveModal(dlg, errBox, doApi, okMsg) { try { await doApi(); await refresh(); dlg.close(); banner(okMsg, true); } catch (e) { errBox.textContent = e.message; } }` and route the feed/recipe/out save buttons (350-362, 430-441, 523-537) through it, keeping validation/body-building inline.
- [ ] **Step 5: Gate** — `make build-be` (embeds the asset), then manually: open `srr serve`, exercise feeds/recipes/syndicate tabs, a save success + a save error, and a failing feed's tooltip.
- [ ] **Step 6: Commit** — `git commit -m "refactor(serve): admin-console cleanups (snapshot mirror, healthDot, modal helpers)"`

---

## Task S6: CSS dedup + dead-rule removal (Medium #6 + Quick #18, #19, #20)

> **Coordinate:** Medium #6 and Quick #18 touch the **same** `styles.css` health-tint block — do #6 and fold #18's merge into it (don't apply both separately). Quick #20 is in a *different* file (`backend/webui/app.css`).

**Files:** `frontend/src/styles.css:123-128,154-164,799-806,814-821`; `frontend/src/js/config.ts:218-220`; `frontend/src/js/config.test.ts:248,294-295`; `backend/webui/app.css:304-306`.

- [ ] **Step 1 (Medium #6 + Quick #18 — one health-tint pass):** Delete the parallel `srr-info-${grade}` class (`config.ts:218-220`) and drive the ⓘ tint off the row's `data-grade` block; while there, fold the two byte-identical `var(--accent)` `crit`/`active` rules into one selector list (keep it **after** the warn rule — equal specificity, source order is load-bearing). Delete the now-redundant `srr-info-*` assertions in `config.test.ts:248,294-295`.
- [ ] **Step 2 (Quick #19):** Delete the redundant `color: var(--muted)` on `.srr-desk` and `.srr-kicker-link` (`styles.css:123-128,154-164`) — inherited from `.srr-kicker`.
- [ ] **Step 3 (Quick #20):** Delete the dead `.toolbar.spread { margin-bottom: 0.6em; }` rule (`backend/webui/app.css:304-306`) — the `spread` class is used nowhere.
- [ ] **Step 4: Gate** — `cd frontend && npx vitest run src/js/config.test.ts` (Step 1's test edits) + `make build-fe`; `make build-be` for the webui CSS. Manual: warn/crit feed still tints; kicker unchanged.
- [ ] **Step 5: Commit** — `git commit -m "refactor(reader,serve): collapse duplicate health tints and drop dead CSS"`

---

## Task S7: Test-helper dedup + dead-setup removal (Quick #7, #13, #14, #15, #21, #22)

Behavior-preserving test cleanups. Do **after S1** (it decides which serve tests survive).

> **Coordinate with Part A:** Quick #22 edits `frontend/src/js/app.test.ts`, which Part A **Task 6** also edits (adds focus tests) — apply #22 after Task 6.

**Files:** `backend/serve_tools_test.go:18-29`; `backend/serve_feeds_test.go:62-66,104-105`; `backend/cmd_recipe_test.go:11-14`; `backend/feed_test.go:831-834`; `frontend/src/js/app.test.ts:324-340`.

- [ ] **Step 1 (Quick #7):** In `TestPreview` replace inline copies of `rssServer`/`allowLoopback` with `allowLoopback(t)` + `rssServer(t)`; **delete the now-unused `net/http/httptest` and `srrb/mod` imports** (build fails otherwise).
- [ ] **Step 2 (Quick #15):** In `feed_test.go:831-834` (`TestSelfhostMarkerRoundTripsToAssetsKey`) replace the inline `mod.AllowPrivateFetch` save/set/cleanup block with `allowLoopback(t)`; keep its custom-body server.
- [ ] **Step 3 (Quick #13):** Delete `stubResolve` (`serve_feeds_test.go:62-66`); point its 7 callers (`serve_feeds_test.go` ×5, `serve_tools_test.go` ×2) at the pre-existing `stubPassthroughResolve()`. (Do **not** delete `stubPassthroughResolve`.)
- [ ] **Step 4 (Quick #14):** Delete `setupRecipeTestStore` (`cmd_recipe_test.go:11-14`); replace its 6 call sites with the pre-existing `setupEmptyDB(t)`.
- [ ] **Step 5 (Quick #21):** `serve_feeds_test.go:104-105` → `_, _, dir := setupTestDB(t)` and drop the `_ = db` discard.
- [ ] **Step 6 (Quick #22):** Delete the dead `data.db.feeds = { 7: { nt: true } }` setup line (`app.test.ts:326`) — the test renders feed 1, so feed 7 is never read.
- [ ] **Step 7: Gate** — `cd backend && go test .` and `cd frontend && npx vitest run src/js/app.test.ts`.
- [ ] **Step 8: Commit** — `git commit -m "test: dedup serve/feed test helpers and drop dead test setup"`

---

## Task S8: Independent leftovers (Quick #3, #5, #10, #12, #16, #17 + Medium #2, #3, #5)

Each touches isolated code; any order. Two have Part A overlaps (flagged). One commit per item or grouped — your call.

**Files:** see each item.

- [ ] **Quick #3 — inline `newFetchRun`** (`feed.go:122-137` → `cmd_fetch.go:149`): delete the constructor + doc; inline the full `&fetchRun{…}` literal **including** `maxAssetSize: int(assets.maxBytes)`. Matches the 14 raw-literal test sites. Gate: `go test -run TestFetch ./...`.
- [ ] **Quick #5 — narrow the `walkAssetAttrs` callback** (`mod/helper_assets.go:97,134,143`): change the callback type to `fn func(val string) (string, bool, error)`; call becomes `fn(n.Attr[i].Val)`; update all four closures (`helper_assets.go:81`, `selfhost.go:88`, and the two test closures `helper_assets_test.go:133,152`) to drop the unused `tag`/`attr` params. Gate: `go test ./mod/`.
- [ ] **Quick #10 — collapse `removeOutFeed` format branching** (`cmd_syndicate.go:138-145`): drop the `format` var + `exts` map + if/else; `for _, ext := range []string{".rss", ".json"} { _ = db.Rm(ctx, "out/"+name+ext) }`. **Coordinate with Part A Task 1** — keep its `validOutName` guard at the top of the function. Gate: `go test -run 'TestSyndicate|TestRemoveOutFeed' .`.
- [ ] **Quick #12 — drop the unreachable serve fetch-loop error branch** (`cmd_serve.go:60-65`): `fetchLoop` runs only under `if o.Interval > 0`, so it returns only nil; drop the `if err != nil { slog.Error(…) }` wrap and the now-unused `log/slog` import. Gate: `go build .`. *(Verify the import is unused after the edit.)*
- [ ] **Quick #16 — drop redundant empty-recipe defaulting in `handlePreview`** (`serve_tools.go:31-34`): pass `q.Get("recipe")` straight to `renderPreview` (whose `recipeFor` already falls back); delete the local default var (the file's only `defaultRecipeName` ref). Gate: `go test -run TestPreview .`.
- [ ] **Quick #17 — `secrets.<NAME>` falls through to the shared error** (`cmd_config.go:93-99`): delete only the duplicate `return fmt.Errorf("unknown config key: %s", o.Key)` line, keeping the `CutPrefix` guard; a missing secret reaches the identical terminal error at line 128. Gate: `go test -run TestConfig .`.
- [ ] **Medium #2 — extract shared OPML import pipeline** (`serve_tools.go:136-152` + `cmd_import.go:50-66`): add `resolveImportBatch(ctx, newFeeds, recipe, tag)` in `cmd_import.go` holding `applyImportDefaults → importRecipes → validate stamped recipe → resolveImportFeeds` (move the eager-validate rationale comment into it); callers keep their tails. **Coordinate with Part A Task 4** (`handleImport` `tagOverride`) — apply after Task 4 so the helper carries the `?tag` fix. Gate: `go test -run 'TestImport|TestHandleImport' .`.
- [ ] **Medium #3 — collapse `SubprocessEnv`** (`mod/secrets.go:28-48`): keep the empty short-circuit, then `kv := …append(k+"="+v)…; slices.Sort(kv); return append(os.Environ(), kv...)` (drop the map-merge + the `maps`/`strings` imports). `exec.Cmd.Env` last-wins makes secrets win; update the docstring and move `secrets_test.go:49-58` from a slice-dedup assertion to an effective-value one. Gate: `go test ./mod/`.
- [ ] **Medium #5 — one `resolveFeedProbe` helper** (`cmd_feeds.go:135-148,212-233` + `serve_feeds.go:105-126`): extract `resolveFeedProbe(ctx, db, recipe, oldURL, newURL)` doing `validateRecipeRef` then the conditional `resolveFeedURL`; route `AddCmd`/`UpdCmd`/`saveFeed` through it. **Coordinate with Part A Task 2** — Task 2's `v.NoTitle = ch.NoTitle` preserve sits in a different part of `saveFeed`; keep both. Gate: `go test -run 'TestFeed' .`.
- [ ] **Commit** — one per item, e.g. `git commit -m "refactor(serve): <item>"`.

---

## Final Verification

- [ ] **Run the full gate**

Run: `make verify`
Expected: PASS — `verify-fe` (lint + format + test + build) + `verify-be` (vet + gofmt + build + test + generate-check) + the e2e contract layer all green. No `format.gen.ts` drift (no contract atoms changed by Part A or Part B).

- [ ] **Confirm scope**

Run: `git log --oneline origin/main..HEAD | head -30` and confirm the Part A fix commits then the Part B `refactor`/`test` commits sit on top; `git status` clean. (Part B is behavior-preserving, so the only new tests are Part A's — `make verify` green with no `format.gen.ts` drift is the real acceptance signal.)

---

## Self-Review Notes

- **Spec coverage:** All 12 distinct confirmed findings are covered — the 7 NoTitle-clobber reports collapse to Task 2; the two focus reports (empty-reader + titleless-render) collapse to Task 6; the two XSS and two import reports collapse to Tasks 3 and 4. The `TestFeedListViewEmitsNoTitle` "false-confidence" finding is addressed by Task 2's real round-trip test (the old read-projection test is left in place, now complemented).
- **No contract change:** none of these touch idx/data/meta formats, `format.gen.ts`, or pack addressing, so `make generate-check` stays green.
- **Webui caveat:** Tasks 3 and 9 (`backend/webui/app.js`) have no automated test (embedded static asset); they are gated by `make build-be` + the manual checks noted, the same coverage posture the existing webui code ships with.
- **Risk ordering:** Tasks 1–2 (HIGH) first; Task 11 (nav) is the most delicate (load-bearing filter state) and is isolated to `applyFilter` so `switchFilter` and `filter.set` are untouched.

### Part B — Simplification self-review

- **Coverage:** all 28 confirmed simplifications (22 quick wins + 6 medium, after merging 4 overlaps out of 32 verified) map to Tasks S1–S8; the mapping table at the top of Part B is the index. Each passed ≥2/3 adversarial verification (feasibility / net-simplicity / in-scope-value) over the same `origin/main...HEAD` range. No proposal was scoped "radical."
- **Why no failing-test-first:** Part B is behavior-preserving, so its gate is the *existing* suite + build staying green, not a new red test. The one place coverage actually changes is S1 (rewriting test readbacks after deleting GET endpoints) and the doc-only `backend/CLAUDE.md` edits in S1/S2.
- **Part A ↔ Part B overlaps (apply B after the named A task):** `removeOutFeed` — Task 1 guard vs **S8/Quick #10** body; `saveFeed` — Task 2 `NoTitle` preserve vs **S8/Medium #5** probe helper (different blocks); `backend/webui/app.js` — Tasks 3 & 9 vs **S5**; `frontend/src/js/app.test.ts` — Task 6 vs **S7/Quick #22**; `handleImport` `?tag` — Task 4 vs **S8/Medium #2**.
- **Biggest judgment call:** S1 removes a *documented* REST surface; it carries an explicit keep-or-remove gate and a narrow-slice fallback. Everything else is a contained delete/inline/dedup.
- **Cost note:** Part B was produced by `find-simplifications-unpushed` — full multi-round runs are expensive (see the `workflow-dynamic-run-cost-cap` memory); re-derive with `{rounds: N}` if the diff changes materially.
