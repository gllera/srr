# `srr serve` Web Admin GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `srr serve` subcommand that runs a localhost HTTP server exposing an embedded vanilla web GUI plus a JSON API to manage feeds, tags, recipes, syndication, OPML, gen, fetch, and inspect — reusing the existing in-process DB operations.

**Architecture:** A new kong subcommand (`ServeCmd`) builds an `http.ServeMux` (Go 1.26 method+wildcard routing), serves an embedded `webui/` bundle via `//go:embed` at `/`, and registers JSON handlers under `/api/*`. Every handler opens its own `withDB` scope per request (read-only → no lock; mutating → `withDB(true)` acquire/commit/release). No persistent lock, no shared DB handle. A Host/Origin allowlist middleware blocks cross-origin access to the mutating API.

**Tech Stack:** Go stdlib `net/http` + `//go:embed` (no new deps); hand-written HTML/CSS/vanilla-JS UI (no build step); existing `withDB`/`feedView`/recipe/syndicate/fetch/preview/import/export helpers.

**Spec:** `docs/superpowers/specs/2026-06-27-serve-admin-gui-design.md`

**Branch:** `feat/serve-admin-gui` (already created).

---

## File Structure

**New files (all under `backend/`):**

- `cmd_serve.go` — `ServeCmd` struct + `Run()` (signal-aware graceful shutdown), `//go:embed webui`, `newMux()`, `registerAPI()`, the Host-guard middleware + loopback helpers, and the shared JSON/HTTP helpers (`writeJSON`, `writeErr`, `decodeJSON`, `pathID`).
- `serve_feeds.go` — feed + tag handlers (`listFeeds`, `getFeed`, `createFeed`, `updateFeed`, `deleteFeed`, `applyFeedsHandler`, `listTags`) plus `feedListView`/`listViewOf` and the shared `saveFeed` upsert helper.
- `serve_recipes.go` — recipe handlers (`listRecipes`, `putRecipe`, `deleteRecipe`) plus the extracted `setRecipe`/`removeRecipe`.
- `serve_syndicate.go` — syndicate handlers (`listSyndicate`, `putSyndicate`, `deleteSyndicate`) plus the extracted `setOutFeed`/`removeOutFeed`.
- `serve_fetch.go` — the SSE fetch handler (`handleFetch`, `writeSSE`).
- `serve_tools.go` — `handlePreview`, `handleInspect`, `handleImport`, `handleExport`, `getGen`, `bumpGen`.
- `cmd_serve_test.go`, `serve_feeds_test.go`, `serve_recipes_test.go`, `serve_syndicate_test.go`, `serve_tools_test.go`, `serve_fetch_test.go` — handler tests.
- `webui/index.html`, `webui/app.css`, `webui/app.js` — the embedded UI (grows across phases).

**Modified files:**

- `main.go` — add `Serve ServeCmd` to the `CLI` struct.
- `cmd_recipe.go` — refactor `RecipeSetCmd.Run`/`RecipeRmCmd.Run` to call the extracted `setRecipe`/`removeRecipe`.
- `cmd_syndicate.go` — refactor `SyndicateSetCmd.Run`/`SyndicateRmCmd.Run` to call the extracted `setOutFeed`/`removeOutFeed`.
- `cmd_fetch.go` — refactor `FetchCmd.fetch` body into `runFetch(ctx, client, filter, onFeed)`; `fetch` becomes a thin caller.
- `cmd_preview.go` — extract the render loop into `renderPreview(...)`; `PreviewCmd.Run` calls it.

**Conventions to follow** (from `backend/CLAUDE.md`): imports stdlib → external → internal, blank-line separated; wrap errors with `fmt.Errorf("context: %w", err)`; no custom error types/sentinels (use stdlib `os.ErrExist` for lock detection); `SRR_`-prefixed env vars.

---

## A note on testing patterns

All handler tests share one shape. Add this helper to `cmd_serve_test.go` in Task 1; later test files reuse it:

```go
// doReq drives a request through the full mux (incl. the Host guard) with a
// loopback Host so the guard passes. body is "" for none.
func doReq(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, r)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

Tests seed the store with `setupTestDB(t)` (sets `globals.Store` to a temp dir, returns an unlocked `*DB`). Seed feeds via the returned db, then exercise handlers — which open their own `withDB` against the same `globals.Store`. Mutating handlers create/remove `.locked`; the unlocked seed db never conflicts. Re-read state with a fresh `withDB(false, …)` or the GET handler.

Seed helper (also Task 1):

```go
// seedFeed adds one feed to the store and commits it.
func seedFeed(t *testing.T, db *DB, ch *Feed) {
	t.Helper()
	if err := db.AddFeed(ch); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}
```

(`ctx` is the package-level `var ctx = context.Background()` defined in `db_test.go`.)

---

# Phase 1 — Server skeleton + Feeds + Tags

Delivers the core ask: a running `srr serve` with a Feeds tab (list, search, tag filter, add/edit/delete, OPML import/export).

## Task 1: Server skeleton, embed, Host guard, JSON helpers

**Files:**
- Create: `backend/cmd_serve.go`
- Create: `backend/webui/index.html`, `backend/webui/app.css`, `backend/webui/app.js`
- Create: `backend/cmd_serve_test.go`
- Modify: `backend/main.go` (add `Serve` to `CLI`)

- [ ] **Step 1: Create the UI shell so the embed has content**

`backend/webui/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' fill='%23f26522'><circle cx='1' cy='7' r='1'/><path d='M0 3v1a4 4 0 014 4h1A5 5 0 000 3z'/><path d='M0 0v1a7 7 0 017 7h1A8 8 0 000 0z'/></svg>" />
<title>SRR Admin</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<header>
  <h1>SRR Admin</h1>
  <nav id="tabs">
    <button data-tab="feeds" class="active">Feeds</button>
    <button data-tab="recipes">Recipes</button>
    <button data-tab="syndicate">Syndicate</button>
    <button data-tab="tools">Tools</button>
  </nav>
</header>
<div id="banner" hidden></div>
<main>
  <section id="feeds" class="tab active"></section>
  <section id="recipes" class="tab"></section>
  <section id="syndicate" class="tab"></section>
  <section id="tools" class="tab"></section>
</main>
<script src="app.js"></script>
</body>
</html>
```

`backend/webui/app.css`:

```css
:root { color-scheme: light dark; --accent: #f26522; --line: #ccc; }
* { box-sizing: border-box; }
body { max-width: 1000px; margin: 0 auto; padding: 1em; font-family: system-ui, sans-serif; line-height: 1.4; }
header { display: flex; align-items: baseline; gap: 1.5em; border-bottom: 2px solid var(--accent); padding-bottom: .5em; }
h1 { margin: 0; font-size: 1.3em; color: var(--accent); }
nav button { background: none; border: none; font: inherit; padding: .4em .6em; cursor: pointer; color: inherit; opacity: .6; }
nav button.active { opacity: 1; border-bottom: 2px solid var(--accent); }
.tab { display: none; padding-top: 1em; }
.tab.active { display: block; }
#banner { margin: .6em 0; padding: .6em .8em; border-radius: 4px; background: #fdecea; color: #611a15; border: 1px solid #f5c6cb; white-space: pre-wrap; }
#banner.ok { background: #e6f4ea; color: #1e4620; border-color: #b7dfc1; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .35em .5em; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; }
td a { color: inherit; }
button.btn { font: inherit; padding: .35em .7em; cursor: pointer; }
.toolbar { display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .8em; }
.toolbar input, .toolbar select { font: inherit; padding: .3em; }
.dot { display: inline-block; width: .7em; height: .7em; border-radius: 50%; }
.dot.green { background: #2e9e44; } .dot.amber { background: #e0a800; }
.dot.red { background: #d33; } .dot.gray { background: #999; }
dialog { border: 1px solid var(--line); border-radius: 6px; padding: 1em; min-width: 340px; }
dialog label { display: block; margin: .5em 0 .15em; font-size: .9em; }
dialog input, dialog select { width: 100%; font: inherit; padding: .35em; }
dialog .row { display: flex; gap: .5em; justify-content: flex-end; margin-top: 1em; }
.muted { color: #888; font-size: .85em; }
article.preview { border-bottom: 1px solid var(--line); padding: .8em 0; }
article.preview .content img { max-width: 100%; height: auto; }
pre.log { background: #0001; padding: .6em; border-radius: 4px; max-height: 50vh; overflow: auto; white-space: pre-wrap; }
```

`backend/webui/app.js`:

```javascript
"use strict";

// --- tiny fetch helpers -----------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
const apiGet = (p) => api("GET", p);

function banner(msg, ok) {
  const b = document.getElementById("banner");
  b.textContent = msg;
  b.hidden = false;
  b.classList.toggle("ok", !!ok);
  if (ok) setTimeout(() => (b.hidden = true), 2500);
}
function clearBanner() { document.getElementById("banner").hidden = true; }

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}

// --- tab router -------------------------------------------------------------
const renderers = {}; // tab name -> async render fn (filled by later phases)

function showTab(name) {
  for (const b of document.querySelectorAll("#tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab"))
    s.classList.toggle("active", s.id === name);
  clearBanner();
  const r = renderers[name];
  if (r) r().catch((e) => banner(e.message));
}

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));

showTab("feeds");
```

- [ ] **Step 2: Write the Go server, embed, routing, Host guard, helpers**

`backend/cmd_serve.go`:

```go
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed webui
var webuiFS embed.FS

type ServeCmd struct {
	Addr string `short:"a" default:"localhost:8088" env:"SRR_SERVE_ADDR" help:"Address to listen on (loopback only by default)."`
}

func (o *ServeCmd) Run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	srv := &http.Server{Addr: o.Addr, Handler: newMux()}
	go func() {
		<-ctx.Done()
		sctx, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = srv.Shutdown(sctx)
	}()

	fmt.Printf("SRR admin GUI at http://%s  (store: %s)\n", o.Addr, globals.Store)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// newMux wires the API routes and the embedded UI, wrapped in the Host guard.
func newMux() http.Handler {
	mux := http.NewServeMux()
	registerAPI(mux)
	sub, err := fs.Sub(webuiFS, "webui")
	if err != nil {
		panic(err) // embed is compile-time; a failure here is a build bug
	}
	mux.Handle("GET /", http.FileServerFS(sub))
	return hostGuard(mux)
}

// hostGuard rejects requests whose Host (or cross-origin Origin) is not a
// loopback address — anti-CSRF/DNS-rebinding hardening for the mutating API.
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host) {
			http.Error(w, "forbidden: non-loopback Host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !loopbackHost(u.Host) {
				http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func loopbackHost(host string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// --- shared JSON/HTTP helpers ----------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// writeErr maps a handler error to a status: lock contention → 409,
// "not found" → 404, everything else → 400. The message is always echoed.
func writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, os.ErrExist) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "store is locked by another srr process — the fetch loop may be running; try again",
		})
		return
	}
	status := http.StatusBadRequest
	if strings.Contains(err.Error(), "not found") {
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeJSON(r *http.Request, v any) error {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return fmt.Errorf("decode request body: %w", err)
	}
	return nil
}

func pathID(r *http.Request) (int, error) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		return 0, fmt.Errorf("invalid feed id %q", r.PathValue("id"))
	}
	return id, nil
}

// registerAPI is grown across phases. Phase 1 wires only the UI placeholder;
// real routes are added by their tasks.
func registerAPI(mux *http.ServeMux) {}
```

- [ ] **Step 3: Register the command in the CLI**

In `backend/main.go`, add to the `CLI` struct (after the `Preview` line):

```go
	Serve     ServeCmd       `cmd:"" help:"Serve a local web admin GUI for managing feeds, recipes, syndication."`
```

- [ ] **Step 4: Write the skeleton test**

`backend/cmd_serve_test.go`:

```go
package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func doReq(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, r)
	req.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func seedFeed(t *testing.T, db *DB, ch *Feed) {
	t.Helper()
	if err := db.AddFeed(ch); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	if err := db.Commit(context.Background()); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

func TestServeUIIndex(t *testing.T) {
	h := newMux()
	rec := doReq(t, h, "GET", "/", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, want text/html", ct)
	}
	if !strings.Contains(rec.Body.String(), "<title>SRR Admin</title>") {
		t.Fatalf("index body missing title; got:\n%s", rec.Body.String()[:200])
	}
}

func TestServeHostGuardRejectsNonLoopback(t *testing.T) {
	h := newMux()
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "evil.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-loopback Host = %d, want 403", rec.Code)
	}
}

func TestServeHostGuardRejectsCrossOrigin(t *testing.T) {
	h := newMux()
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "localhost"
	req.Header.Set("Origin", "http://evil.example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin = %d, want 403", rec.Code)
	}
}
```

- [ ] **Step 5: Run the tests — verify pass**

Run: `cd backend && go test -run 'TestServe(UIIndex|HostGuard)' .`
Expected: PASS (3 tests). If `go vet` flags the unused `loopbackHost`/helpers, that's fixed once Task 2+ use them — they are already used by `hostGuard`.

- [ ] **Step 6: Build to confirm embed + CLI wiring**

Run: `cd backend && go build -o /tmp/srrb . && /tmp/srrb serve --help`
Expected: build succeeds; help shows `serve` with `--addr` default `localhost:8088`.

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_serve.go backend/main.go backend/cmd_serve_test.go backend/webui/
git commit -m "feat(serve): srr serve skeleton — embedded UI shell, host guard, JSON helpers"
```

## Task 2: Feed list + show endpoints

**Files:**
- Create: `backend/serve_feeds.go`
- Modify: `backend/cmd_serve.go` (`registerAPI`)
- Create: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing test**

`backend/serve_feeds_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestListFeeds(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Beta", URL: "https://b.example/feed", Tag: "news", FailStreak: 4, FetchError: "boom", TotalArt: 12})
	seedFeed(t, db, &Feed{Title: "Alpha", URL: "https://a.example/feed", LastOK: 1700000000})

	rec := doReq(t, newMux(), "GET", "/api/feeds", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	// Sorted case-insensitively by title: Alpha before Beta.
	if got[0].Title != "Alpha" || got[1].Title != "Beta" {
		t.Fatalf("order = %q,%q want Alpha,Beta", got[0].Title, got[1].Title)
	}
	if got[1].FailStreak != 4 || got[1].Error != "boom" || got[1].TotalArt != 12 {
		t.Fatalf("health fields missing: %+v", got[1])
	}
}

func TestGetFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Only", URL: "https://o.example/feed"})

	rec := doReq(t, newMux(), "GET", "/api/feeds/0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != 0 || got.Title != "Only" {
		t.Fatalf("got %+v", got)
	}
}

func TestGetFeedNotFound(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/feeds/99", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run 'TestListFeeds|TestGetFeed' .`
Expected: FAIL — `feedListView` undefined, route 404.

- [ ] **Step 3: Implement the view + handlers**

`backend/serve_feeds.go`:

```go
package main

import (
	"context"
	"net/http"
	"sort"
	"strings"
)

// feedListView is the read-only feed shape the GUI table consumes: the writable
// feedView fields plus server-owned health fields. Writes (POST/PUT) accept only
// the feedView subset (title/url/tag/recipe).
type feedListView struct {
	ID         int    `json:"id"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	Tag        string `json:"tag,omitempty"`
	Recipe     string `json:"recipe,omitempty"`
	Error      string `json:"error,omitempty"`
	FailStreak int    `json:"fail_streak"`
	LastOK     int64  `json:"last_ok"`
	LastNew    int64  `json:"last_new"`
	TotalArt   int    `json:"total_art"`
}

func listViewOf(ch *Feed) feedListView {
	return feedListView{
		ID:         ch.id,
		Title:      ch.Title,
		URL:        ch.URL,
		Tag:        ch.Tag,
		Recipe:     ch.Recipe,
		Error:      ch.FetchError,
		FailStreak: ch.FailStreak,
		LastOK:     ch.LastOK,
		LastNew:    ch.LastNew,
		TotalArt:   ch.TotalArt,
	}
}

func listFeeds(w http.ResponseWriter, r *http.Request) {
	var out []feedListView
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = make([]feedListView, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			out = append(out, listViewOf(ch))
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	writeJSON(w, http.StatusOK, out)
}

func getFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var view feedListView
	err = withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		ch, e := db.FeedByID(id)
		if e != nil {
			return e
		}
		view = listViewOf(ch)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
```

- [ ] **Step 4: Wire the routes**

In `backend/cmd_serve.go`, replace the empty `registerAPI` body:

```go
func registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/feeds", listFeeds)
	mux.HandleFunc("GET /api/feeds/{id}", getFeed)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test -run 'TestListFeeds|TestGetFeed' .`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/serve_feeds.go backend/cmd_serve.go backend/serve_feeds_test.go
git commit -m "feat(serve): GET /api/feeds + /api/feeds/{id}"
```

## Task 3: Feed create endpoint + lock-contention 409

**Files:**
- Modify: `backend/serve_feeds.go` (add `saveFeed`, `createFeed`)
- Modify: `backend/cmd_serve.go` (route)
- Modify: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/serve_feeds_test.go`:

```go
// stubResolve makes subscribe-time discovery a no-op (offline) for the test.
func stubResolve(t *testing.T) {
	t.Helper()
	prev := resolveFeedURL
	resolveFeedURL = func(_ context.Context, url string) (string, error) { return url, nil }
	t.Cleanup(func() { resolveFeedURL = prev })
}

func TestCreateFeed(t *testing.T) {
	setupTestDB(t)
	stubResolve(t)
	body := `{"title":"New","url":"https://n.example/feed","tag":"news"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != 0 || got.Title != "New" || got.Tag != "news" {
		t.Fatalf("got %+v", got)
	}

	// Round-trip: it is now listed.
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	if !strings.Contains(list.Body.String(), "https://n.example/feed") {
		t.Fatalf("created feed not listed: %s", list.Body)
	}
}

func TestCreateFeedBadRecipe(t *testing.T) {
	setupTestDB(t)
	stubResolve(t)
	body := `{"title":"X","url":"https://x.example/feed","recipe":"nope"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreateFeedLockContention(t *testing.T) {
	db, _, dir := setupTestDB(t)
	_ = db
	stubResolve(t)
	// Hold the lock the way another srr process would.
	lock := dir + "/" + dbLockKey
	if err := osWriteFile(lock); err != nil {
		t.Fatal(err)
	}
	body := `{"title":"X","url":"https://x.example/feed"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}
```

Add this tiny helper to the bottom of `serve_feeds_test.go` (avoids importing `os` for one call elsewhere):

```go
func osWriteFile(path string) error { return os.WriteFile(path, nil, 0o644) }
```

…and add `"os"` and `"context"` to the test file's imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run TestCreateFeed .`
Expected: FAIL — `createFeed`/route missing.

- [ ] **Step 3: Implement saveFeed + createFeed**

Append to `backend/serve_feeds.go` (and add `"fmt"` to its imports):

```go
// saveFeed upserts one feedView, with the same subscribe-time discovery gating
// as `feed add`/`feed upd -u`: probe when the effective ingest is #feed and the
// URL is new (create) or changed (update). Shared by the POST and PUT handlers
// so the GUI matches the CLI. Returns the stored *Feed for echo-back.
func saveFeed(ctx context.Context, db *DB, v *feedView) (*Feed, error) {
	if v.Title == "" {
		return nil, fmt.Errorf("title required")
	}
	if !validFeedURL(v.URL) {
		return nil, fmt.Errorf("invalid url %q", v.URL)
	}
	if err := validateRecipeRef(db.core.Recipes, v.Recipe); err != nil {
		return nil, err
	}
	isCreate := v.ID == nil
	var ch *Feed
	if isCreate {
		ch = &Feed{}
	} else {
		existing, err := db.FeedByID(*v.ID)
		if err != nil {
			return nil, err
		}
		ch = existing
	}
	newURL := v.URL
	if ch.URL != newURL && resolvesFeed(db.core.Recipes, v.Recipe) {
		resolved, err := resolveFeedURL(ctx, newURL)
		if err != nil {
			return nil, fmt.Errorf("resolve feed %q: %w", newURL, err)
		}
		newURL = resolved
	}
	ch.Title = v.Title
	setFeedURL(ch, newURL)
	ch.Tag = v.Tag
	ch.Recipe = v.Recipe
	if err := normalizeFeed(ch, db.core.Recipes); err != nil {
		return nil, err
	}
	if isCreate {
		if err := db.AddFeed(ch); err != nil {
			return nil, err
		}
	}
	return ch, db.Commit(ctx)
}

func createFeed(w http.ResponseWriter, r *http.Request) {
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = nil // create ignores any id in the body
	var saved *Feed
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		s, e := saveFeed(ctx, db, &v)
		saved = s
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listViewOf(saved))
}
```

- [ ] **Step 4: Wire the route**

In `registerAPI`, add (note: `POST /api/feeds/apply` is added in Task 5; keep this above the `{id}` routes for readability):

```go
	mux.HandleFunc("POST /api/feeds", createFeed)
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test -run TestCreateFeed .`
Expected: PASS (3 tests). The 409 test proves `withDB(true)` surfaces `os.ErrExist` through `writeErr`.

- [ ] **Step 6: Commit**

```bash
git add backend/serve_feeds.go backend/cmd_serve.go backend/serve_feeds_test.go
git commit -m "feat(serve): POST /api/feeds (create) + 409 on lock contention"
```

## Task 4: Feed update + delete endpoints

**Files:**
- Modify: `backend/serve_feeds.go` (`updateFeed`, `deleteFeed`)
- Modify: `backend/cmd_serve.go` (routes)
- Modify: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/serve_feeds_test.go`:

```go
func TestUpdateFeedPreservesStateOnSameURL(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", FailStreak: 3, FetchError: "x"})

	body := `{"title":"Renamed","url":"https://u.example/feed","tag":"news"}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	// Same URL ⇒ fetch state preserved.
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, _ := d.FeedByID(0)
		if ch.Title != "Renamed" || ch.Tag != "news" {
			t.Fatalf("not updated: %+v", ch)
		}
		if ch.FailStreak != 3 || ch.FetchError != "x" {
			t.Fatalf("fetch state should be preserved: %+v", ch)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUpdateFeedResetsStateOnNewURL(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", FailStreak: 3, FetchError: "x"})

	body := `{"title":"Old","url":"https://v.example/feed"}`
	doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	withDB(false, func(_ context.Context, d *DB) error {
		ch, _ := d.FeedByID(0)
		if ch.URL != "https://v.example/feed" || ch.FailStreak != 0 || ch.FetchError != "" {
			t.Fatalf("new URL should reset state: %+v", ch)
		}
		return nil
	})
}

func TestDeleteFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Doomed", URL: "https://d.example/feed"})

	rec := doReq(t, newMux(), "DELETE", "/api/feeds/0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	get := doReq(t, newMux(), "GET", "/api/feeds/0", "")
	if get.Code != http.StatusNotFound {
		t.Fatalf("after delete GET = %d, want 404", get.Code)
	}
}

func TestDeleteFeedNotFound(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "DELETE", "/api/feeds/42", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run 'TestUpdateFeed|TestDeleteFeed' .`
Expected: FAIL — handlers/routes missing.

- [ ] **Step 3: Implement the handlers**

Append to `backend/serve_feeds.go`:

```go
func updateFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = &id
	var saved *Feed
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		s, e := saveFeed(ctx, db, &v)
		saved = s
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listViewOf(saved))
}

func deleteFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		if _, e := db.FeedByID(id); e != nil {
			return e // 404 when absent
		}
		db.RemoveFeed(id)
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
```

- [ ] **Step 4: Wire the routes**

In `registerAPI`, add:

```go
	mux.HandleFunc("PUT /api/feeds/{id}", updateFeed)
	mux.HandleFunc("DELETE /api/feeds/{id}", deleteFeed)
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test -run 'TestUpdateFeed|TestDeleteFeed' .`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/serve_feeds.go backend/cmd_serve.go backend/serve_feeds_test.go
git commit -m "feat(serve): PUT/DELETE /api/feeds/{id}"
```

## Task 5: Bulk apply + tags endpoints

**Files:**
- Modify: `backend/serve_feeds.go` (`applyFeedsHandler`, `listTags`, `tagCount`)
- Modify: `backend/cmd_serve.go` (routes)
- Modify: `backend/serve_feeds_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/serve_feeds_test.go`:

```go
func TestApplyFeedsArray(t *testing.T) {
	setupTestDB(t)
	body := `[{"title":"One","url":"https://1.example/feed"},{"title":"Two","url":"https://2.example/feed","tag":"news"}]`
	rec := doReq(t, newMux(), "POST", "/api/feeds/apply", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	var got []feedListView
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
}

func TestApplyFeedsAtomicOnBadElement(t *testing.T) {
	setupTestDB(t)
	// Second element has no url ⇒ whole batch rejected, nothing persisted.
	body := `[{"title":"Good","url":"https://g.example/feed"},{"title":"Bad"}]`
	rec := doReq(t, newMux(), "POST", "/api/feeds/apply", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	var got []feedListView
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 0 {
		t.Fatalf("batch should be atomic; got %d feeds", len(got))
	}
}

func TestListTags(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "A", URL: "https://a.example/feed", Tag: "news", TotalArt: 5})
	seedFeed(t, db, &Feed{Title: "B", URL: "https://b.example/feed", Tag: "news", TotalArt: 3})
	seedFeed(t, db, &Feed{Title: "C", URL: "https://c.example/feed"}) // untagged

	rec := doReq(t, newMux(), "GET", "/api/tags", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got []tagCount
	json.Unmarshal(rec.Body.Bytes(), &got)
	var news *tagCount
	for i := range got {
		if got[i].Tag == "news" {
			news = &got[i]
		}
	}
	if news == nil || news.Feeds != 2 || news.Articles != 8 {
		t.Fatalf("news tag wrong: %+v (all: %+v)", news, got)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run 'TestApplyFeeds|TestListTags' .`
Expected: FAIL — handlers/routes/`tagCount` missing.

- [ ] **Step 3: Implement the handlers**

Append to `backend/serve_feeds.go` (add `"io"` to imports):

```go
func applyFeedsHandler(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := parseApplyInput(data)
	if err != nil {
		writeErr(w, err)
		return
	}
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return applyViews(ctx, db, views)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": len(views)})
}

// tagCount is one tag bucket for the GUI tag filter. Tag "" is the untagged
// bucket. Unlike `srr inspect --list-tags`, feeds with 0 articles are counted
// so brand-new feeds' tags still appear in the filter.
type tagCount struct {
	Tag      string `json:"tag"`
	Feeds    int    `json:"feeds"`
	Articles int    `json:"articles"`
}

func listTags(w http.ResponseWriter, r *http.Request) {
	var out []tagCount
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		agg := map[string]*tagCount{}
		for _, ch := range db.Feeds() {
			t := agg[ch.Tag]
			if t == nil {
				t = &tagCount{Tag: ch.Tag}
				agg[ch.Tag] = t
			}
			t.Feeds++
			t.Articles += ch.TotalArt
		}
		out = make([]tagCount, 0, len(agg))
		for _, t := range agg {
			out = append(out, *t)
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tag < out[j].Tag })
	writeJSON(w, http.StatusOK, out)
}
```

- [ ] **Step 4: Wire the routes**

In `registerAPI`, add (the `apply` literal must be registered; method+path is unambiguous vs `{id}` since apply is POST and `{id}` routes are GET/PUT/DELETE):

```go
	mux.HandleFunc("POST /api/feeds/apply", applyFeedsHandler)
	mux.HandleFunc("GET /api/tags", listTags)
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test -run 'TestApplyFeeds|TestListTags' .`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the whole package; confirm green**

Run: `cd backend && go test .`
Expected: PASS (all existing + new tests).

- [ ] **Step 7: Commit**

```bash
git add backend/serve_feeds.go backend/cmd_serve.go backend/serve_feeds_test.go
git commit -m "feat(serve): POST /api/feeds/apply + GET /api/tags"
```

## Task 6: Feeds tab UI

UI is verified by a Go smoke test (the bytes embed and serve) plus a manual browser checklist — vanilla JS has no unit harness here, by design (spec §Testing).

**Files:**
- Modify: `backend/webui/app.js` (append the feeds module)
- Modify: `backend/cmd_serve_test.go` (smoke test the served JS)

- [ ] **Step 1: Append the feeds module to `backend/webui/app.js`**

Add at the end of the file:

```javascript
// --- feeds tab --------------------------------------------------------------
const feedsState = { feeds: [], tags: [], search: "", tag: "" };

function healthDot(f) {
  let cls = "green";
  if (f.error) cls = f.fail_streak >= 3 ? "red" : "amber";
  else if (!f.last_ok) cls = "gray";
  const title = f.error
    ? `${f.error} (fail streak ${f.fail_streak})`
    : f.last_ok
    ? "ok, last fetch " + new Date(f.last_ok * 1000).toLocaleString()
    : "never fetched";
  return el("span", { class: "dot " + cls, title });
}

function feedMatches(f) {
  if (feedsState.tag && f.tag !== feedsState.tag) return false;
  if (feedsState.search) {
    const q = feedsState.search.toLowerCase();
    if (!(f.title + " " + f.url).toLowerCase().includes(q)) return false;
  }
  return true;
}

async function renderFeeds() {
  [feedsState.feeds, feedsState.tags] = await Promise.all([
    apiGet("/api/feeds"),
    apiGet("/api/tags"),
  ]);
  drawFeeds();
}
renderers.feeds = renderFeeds;

function drawFeeds() {
  const root = document.getElementById("feeds");
  root.replaceChildren();

  const search = el("input", {
    type: "search", placeholder: "search title/url", value: feedsState.search,
    oninput: (e) => { feedsState.search = e.target.value; drawTable(); },
  });
  const tagSel = el("select", {
    onchange: (e) => { feedsState.tag = e.target.value; drawTable(); },
  }, el("option", { value: "" }, "all tags"));
  for (const t of feedsState.tags) {
    const label = (t.tag || "(untagged)") + ` — ${t.feeds}`;
    const o = el("option", { value: t.tag }, label);
    if (t.tag === feedsState.tag) o.selected = true;
    tagSel.append(o);
  }
  const add = el("button", { class: "btn", onclick: () => openFeedModal(null) }, "+ Add feed");

  root.append(el("div", { class: "toolbar" }, search, tagSel, add));
  root.append(el("div", { id: "feedTableWrap" }));
  drawTable();
}

function drawTable() {
  const wrap = document.getElementById("feedTableWrap");
  const rows = feedsState.feeds.filter(feedMatches);
  const table = el("table", {},
    el("thead", {}, el("tr", {},
      el("th", {}, ""), el("th", {}, "title"), el("th", {}, "url"),
      el("th", {}, "tag"), el("th", {}, "recipe"),
      el("th", {}, "arts"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const f of rows) {
    tb.append(el("tr", {},
      el("td", {}, healthDot(f)),
      el("td", {}, f.title),
      el("td", {}, el("a", { href: f.url, target: "_blank", rel: "noopener" }, f.url)),
      el("td", {}, f.tag || ""),
      el("td", {}, f.recipe || ""),
      el("td", {}, String(f.total_art)),
      el("td", {},
        el("button", { class: "btn", onclick: () => openFeedModal(f) }, "edit"),
        " ",
        el("button", { class: "btn", onclick: () => deleteFeed(f) }, "✕"))));
  }
  table.append(tb);
  wrap.replaceChildren(
    el("div", { class: "muted" }, `${rows.length} of ${feedsState.feeds.length} feeds`),
    table);
}

async function deleteFeed(f) {
  if (!confirm(`Delete feed “${f.title}”?`)) return;
  try {
    await api("DELETE", "/api/feeds/" + f.id);
    banner("Deleted " + f.title, true);
    await renderFeeds();
  } catch (e) { banner(e.message); }
}

let feedDialog;
function openFeedModal(f) {
  if (!feedDialog) {
    feedDialog = el("dialog", { id: "feedModal" });
    document.body.append(feedDialog);
  }
  const isEdit = !!f;
  const v = f || { title: "", url: "", tag: "", recipe: "" };
  const title = el("input", { id: "f_title", value: v.title });
  const url = el("input", { id: "f_url", value: v.url });
  const tag = el("input", { id: "f_tag", value: v.tag || "" });
  const recipe = el("input", { id: "f_recipe", value: v.recipe || "", placeholder: "default" });
  const err = el("div", { class: "muted" });

  const save = el("button", { class: "btn", onclick: async () => {
    const body = {
      title: title.value.trim(), url: url.value.trim(),
      tag: tag.value.trim(), recipe: recipe.value.trim(),
    };
    try {
      if (isEdit) await api("PUT", "/api/feeds/" + f.id, body);
      else await api("POST", "/api/feeds", body);
      feedDialog.close();
      banner((isEdit ? "Updated " : "Added ") + body.title, true);
      await renderFeeds();
    } catch (e) { err.textContent = e.message; }
  } }, "Save");

  feedDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit feed #" + f.id : "Add feed"),
    el("label", {}, "Title"), title,
    el("label", {}, "URL"), url,
    el("label", {}, "Tag"), tag,
    el("label", {}, "Recipe (blank = default)"), recipe,
    err,
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => feedDialog.close() }, "Cancel"),
      save));
  feedDialog.showModal();
}
```

- [ ] **Step 2: Add a smoke test for the served JS asset**

Append to `backend/cmd_serve_test.go`:

```go
func TestServeStaticAssets(t *testing.T) {
	h := newMux()
	for _, tc := range []struct{ path, needle string }{
		{"/app.js", "renderFeeds"},
		{"/app.css", "--accent"},
	} {
		rec := doReq(t, h, "GET", tc.path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", tc.path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), tc.needle) {
			t.Fatalf("GET %s missing %q", tc.path, tc.needle)
		}
	}
}
```

- [ ] **Step 3: Run the smoke test**

Run: `cd backend && go test -run TestServeStaticAssets .`
Expected: PASS.

- [ ] **Step 4: Manual browser verification**

```bash
cd backend && go build -o /tmp/srrb .
mkdir -p /tmp/srr-gui-store
/tmp/srrb -o /tmp/srr-gui-store serve
```
Open `http://localhost:8088` and verify:
- Feeds tab loads (empty table, "0 of 0 feeds").
- "+ Add feed" → modal → add `https://hnrss.org/frontpage` → row appears with a gray dot (never fetched).
- Edit the row (change title/tag) → saves, row updates.
- Tag filter and search narrow the list.
- Delete → confirm → row removed.
- Switching tabs (Recipes/Syndicate/Tools) shows empty panels (wired in later phases) without errors.

- [ ] **Step 5: Commit**

```bash
git add backend/webui/app.js backend/cmd_serve_test.go
git commit -m "feat(serve): Feeds tab UI — table, search, tag filter, add/edit/delete"
```

**Phase 1 complete.** `srr serve` runs with a working Feeds manager.

---

# Phase 2 — Recipes + Preview

## Task 7: Recipe endpoints (+ CLI refactor to share logic)

**Files:**
- Modify: `backend/cmd_recipe.go` (extract `setRecipe`/`removeRecipe`; thin the commands)
- Create: `backend/serve_recipes.go` (handlers)
- Modify: `backend/cmd_serve.go` (routes)
- Create: `backend/serve_recipes_test.go`

- [ ] **Step 1: Write the failing tests**

`backend/serve_recipes_test.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestListRecipes(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/recipes", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]Recipe
	json.Unmarshal(rec.Body.Bytes(), &got)
	if _, ok := got["default"]; !ok {
		t.Fatalf("default recipe missing: %+v", got)
	}
}

func TestPutRecipe(t *testing.T) {
	setupTestDB(t)
	body := `{"ingest":"","pipe":["#sanitize","#minify"]}`
	rec := doReq(t, newMux(), "PUT", "/api/recipes/clean", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		r, ok := d.core.Recipes["clean"]
		if !ok || len(r.Pipe) != 2 {
			t.Fatalf("recipe not stored: %+v", d.core.Recipes)
		}
		return nil
	})
}

func TestPutRecipeRejectsDefaultTokenInDefault(t *testing.T) {
	setupTestDB(t)
	body := `{"pipe":["#default"]}`
	rec := doReq(t, newMux(), "PUT", "/api/recipes/default", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteRecipeDefaultRefused(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "DELETE", "/api/recipes/default", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteRecipeReferencedRefused(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := withDB(true, func(ctx context.Context, d *DB) error {
		return setRecipe(ctx, d, "x", "", []string{"#minify"})
	}); err != nil {
		t.Fatal(err)
	}
	seedFeed(t, db, &Feed{Title: "F", URL: "https://f.example/feed", Recipe: "x"})

	rec := doReq(t, newMux(), "DELETE", "/api/recipes/x", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (referenced)", rec.Code)
	}
}

func TestDeleteRecipe(t *testing.T) {
	setupTestDB(t)
	if err := withDB(true, func(ctx context.Context, d *DB) error {
		return setRecipe(ctx, d, "tmp", "", []string{"#minify"})
	}); err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, newMux(), "DELETE", "/api/recipes/tmp", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run 'Recipe' .`
Expected: FAIL — `setRecipe` undefined, routes missing.

- [ ] **Step 3: Extract the shared logic in `cmd_recipe.go`**

Add these two functions to `backend/cmd_recipe.go` (after `RecipeRmCmd.Run`):

```go
// setRecipe upserts a recipe (full-replace), shared by `srr recipe set` and the
// PUT /api/recipes handler. filterPipe + validatePipe enforce the #default rules.
func setRecipe(ctx context.Context, db *DB, name, ingest string, pipe []string) error {
	if name == "" {
		return fmt.Errorf("recipe name is required")
	}
	pipe = filterPipe(pipe)
	if err := validatePipe(pipe, name != defaultRecipeName); err != nil {
		return err
	}
	db.core.Recipes[name] = Recipe{Ingest: ingest, Pipe: pipe}
	return db.Commit(ctx)
}

// removeRecipe deletes a recipe, refusing 'default' and any name still
// referenced by a feed. Shared by `srr recipe rm` and the DELETE handler.
func removeRecipe(ctx context.Context, db *DB, name string) error {
	if name == defaultRecipeName {
		return fmt.Errorf("cannot remove the reserved %q recipe", defaultRecipeName)
	}
	if _, ok := db.core.Recipes[name]; !ok {
		return fmt.Errorf("recipe %q not found", name)
	}
	var refs []int
	for id, ch := range db.Feeds() {
		if ch.Recipe == name {
			refs = append(refs, id)
		}
	}
	if len(refs) > 0 {
		sort.Ints(refs)
		parts := make([]string, len(refs))
		for i, id := range refs {
			parts[i] = fmt.Sprint(id)
		}
		return fmt.Errorf("recipe %q is referenced by feed(s) %s; re-point them first", name, strings.Join(parts, ", "))
	}
	delete(db.core.Recipes, name)
	return db.Commit(ctx)
}
```

Then replace the body of `RecipeSetCmd.Run`:

```go
func (o *RecipeSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return setRecipe(ctx, db, o.Name, o.Ingest, o.Pipe)
	})
}
```

…and replace the body of `RecipeRmCmd.Run`:

```go
func (o *RecipeRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return removeRecipe(ctx, db, o.Name)
	})
}
```

(`sort`, `strings`, `fmt` are already imported in `cmd_recipe.go`.)

- [ ] **Step 4: Implement the handlers**

`backend/serve_recipes.go`:

```go
package main

import (
	"context"
	"net/http"
)

func listRecipes(w http.ResponseWriter, r *http.Request) {
	var recipes map[string]Recipe
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		recipes = make(map[string]Recipe, len(db.core.Recipes))
		for k, v := range db.core.Recipes {
			recipes[k] = v
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, recipes)
}

func putRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var body struct {
		Ingest string   `json:"ingest"`
		Pipe   []string `json:"pipe"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return setRecipe(ctx, db, name, body.Ingest, body.Pipe)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteRecipe(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return removeRecipe(ctx, db, name)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
```

- [ ] **Step 5: Wire the routes**

In `registerAPI`, add:

```go
	mux.HandleFunc("GET /api/recipes", listRecipes)
	mux.HandleFunc("PUT /api/recipes/{name}", putRecipe)
	mux.HandleFunc("DELETE /api/recipes/{name}", deleteRecipe)
```

- [ ] **Step 6: Run to verify pass + existing recipe tests still green**

Run: `cd backend && go test -run 'Recipe' .`
Expected: PASS (new handler tests + the existing `cmd_recipe_test.go` tests, which now exercise the refactored commands).

- [ ] **Step 7: Commit**

```bash
git add backend/cmd_recipe.go backend/serve_recipes.go backend/cmd_serve.go backend/serve_recipes_test.go
git commit -m "feat(serve): recipe endpoints + share setRecipe/removeRecipe with CLI"
```

## Task 8: Preview endpoint (+ extract renderPreview)

**Files:**
- Modify: `backend/cmd_preview.go` (extract `renderPreview`)
- Create: `backend/serve_tools.go` (the `handlePreview` handler; this file grows in Phase 3)
- Modify: `backend/cmd_serve.go` (route)
- Create: `backend/serve_tools_test.go`

- [ ] **Step 1: Write the failing test**

`backend/serve_tools_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const sampleRSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>S</title>
<item><title>Hello</title><link>https://e.example/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item>
</channel></rss>`

func TestPreview(t *testing.T) {
	setupTestDB(t)
	// A local RSS server; allow loopback fetch past the SSRF guard.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	prev := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prev })

	rec := doReq(t, newMux(), "GET", "/api/preview?url="+srv.URL, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got []previewArticle
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Title != "Hello" {
		t.Fatalf("got %+v", got)
	}
}

func TestPreviewRequiresURL(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/preview", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
```

Add `"srrb/mod"` to this test file's imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run TestPreview .`
Expected: FAIL — `renderPreview`/`previewArticle`/route missing.

- [ ] **Step 3: Extract `renderPreview` in `cmd_preview.go`**

Add to `backend/cmd_preview.go` (it already imports `context`, `fmt`, `net/http`, `time`, `srrb/ingest`, `srrb/mod`):

```go
// renderPreview fetches url through the resolved recipe's ingest, runs the
// module pipeline, and returns the processed articles. Shared by PreviewCmd
// (HTML page) and GET /api/preview (JSON). Optional ad-hoc overrides: a non-nil
// pipeOverride replaces the recipe's pipe; a non-empty ingestOverride replaces
// its ingest.
func renderPreview(ctx context.Context, recipes map[string]Recipe, recipeName string, pipeOverride []string, ingestOverride, rawURL string) ([]*Item, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	processor := mod.New()
	engine := ingest.New()

	r := recipeFor(recipes, recipeName)
	def := recipeFor(recipes, defaultRecipeName)
	if len(pipeOverride) > 0 {
		r.Pipe = pipeOverride
	}
	if ingestOverride != "" {
		r.Ingest = ingestOverride
	}
	pipe := resolvePipe(def.Pipe, r.Pipe)
	if err := processor.Validate(ctx, pipe); err != nil {
		return nil, fmt.Errorf("invalid pipeline %v: %w", pipe, err)
	}

	buf := make([]byte, globals.MaxFeedSize*(1<<10)+1)
	name := ingest.Select(r.Ingest, def.Ingest)
	result, err := engine.Fetch(ctx, name, client, buf, ingest.Request{URL: rawURL, MaxSize: cap(buf) - 1})
	if err != nil {
		return nil, fmt.Errorf("ingest %q: %w", name, err)
	}

	articles := make([]*Item, 0, len(result.Items))
	for _, i := range result.Items {
		if i == nil {
			continue
		}
		if err := processItem(ctx, processor, pipe, i); err != nil {
			return nil, err
		}
		if i.Drop {
			continue
		}
		var pub int64
		if i.Published != nil {
			pub = i.Published.Unix()
		}
		articles = append(articles, &Item{Title: i.Title, Content: i.Content, Link: i.Link, Published: pub})
	}
	return articles, nil
}
```

Then replace the body of `PreviewCmd.Run` from the `processor := mod.New()` line through the `articles` build loop with a call to `renderPreview`. Concretely, `Run` becomes:

```go
func (o *PreviewCmd) Run() error {
	var recipes map[string]Recipe
	if err := withDB(false, func(_ context.Context, db *DB) error {
		recipes = db.core.Recipes
		return nil
	}); err != nil {
		return err
	}

	ctx := context.Background()
	articles, err := renderPreview(ctx, recipes, o.Recipe, o.Pipe, o.Ingest, o.URL.String())
	if err != nil {
		return err
	}

	fmt.Printf("Serving %d articles at http://%s\n", len(articles), o.Addr)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := previewTmpl.Execute(w, articles); err != nil {
			log.Println("template error:", err)
		}
	})
	return http.ListenAndServe(o.Addr, mux)
}
```

Remove now-unused imports from `cmd_preview.go` if `go build` flags them (`net/url` stays — `o.URL` is `*url.URL`; `ingest`/`mod` move into `renderPreview` but stay imported because `renderPreview` is in the same file).

- [ ] **Step 4: Implement the handler**

`backend/serve_tools.go`:

```go
package main

import (
	"context"
	"fmt"
	"net/http"
)

// previewArticle is the JSON shape GET /api/preview returns (decoupled from the
// internal Item type).
type previewArticle struct {
	Title     string `json:"title"`
	Link      string `json:"link"`
	Published int64  `json:"published"`
	Content   string `json:"content"`
}

func handlePreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rawURL := q.Get("url")
	if rawURL == "" {
		writeErr(w, fmt.Errorf("url is required"))
		return
	}
	recipe := q.Get("recipe")
	if recipe == "" {
		recipe = defaultRecipeName
	}
	var items []*Item
	err := withDBCtx(r.Context(), false, func(ctx context.Context, db *DB) error {
		var e error
		items, e = renderPreview(ctx, db.core.Recipes, recipe, q["pipe"], q.Get("ingest"), rawURL)
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]previewArticle, 0, len(items))
	for _, i := range items {
		out = append(out, previewArticle{Title: i.Title, Link: i.Link, Published: i.Published, Content: i.Content})
	}
	writeJSON(w, http.StatusOK, out)
}
```

- [ ] **Step 5: Wire the route + run**

In `registerAPI`, add:

```go
	mux.HandleFunc("GET /api/preview", handlePreview)
```

Run: `cd backend && go test -run 'TestPreview|TestCmdPreview' . && go test .`
Expected: PASS (new + existing preview/package tests).

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_preview.go backend/serve_tools.go backend/cmd_serve.go backend/serve_tools_test.go
git commit -m "feat(serve): GET /api/preview + extract renderPreview shared with srr preview"
```

## Task 9: Recipes tab UI + preview + recipe dropdown in feed modal

**Files:**
- Modify: `backend/webui/app.js` (recipes module; upgrade feed modal recipe field)

- [ ] **Step 1: Append the recipes module to `backend/webui/app.js`**

```javascript
// --- recipes tab ------------------------------------------------------------
async function renderRecipes() {
  const recipes = await apiGet("/api/recipes");
  const root = document.getElementById("recipes");
  root.replaceChildren();
  root.append(el("div", { class: "toolbar" },
    el("button", { class: "btn", onclick: () => openRecipeModal(null, null) }, "+ New recipe")));

  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "ingest"), el("th", {}, "pipe"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const name of Object.keys(recipes).sort()) {
    const rcp = recipes[name];
    const actions = el("td", {},
      el("button", { class: "btn", onclick: () => openRecipeModal(name, rcp) }, "edit"));
    if (name !== "default") {
      actions.append(" ", el("button", { class: "btn", onclick: () => deleteRecipe(name) }, "✕"));
    }
    tb.append(el("tr", {},
      el("td", {}, name),
      el("td", {}, rcp.ingest || ""),
      el("td", {}, (rcp.pipe || []).join("  →  ")),
      actions));
  }
  table.append(tb);
  root.append(table);
  root.append(previewPanel());
}
renderers.recipes = renderRecipes;

async function deleteRecipe(name) {
  if (!confirm(`Delete recipe “${name}”?`)) return;
  try {
    await api("DELETE", "/api/recipes/" + encodeURIComponent(name));
    banner("Deleted recipe " + name, true);
    await renderRecipes();
  } catch (e) { banner(e.message); }
}

let recipeDialog;
function openRecipeModal(name, rcp) {
  if (!recipeDialog) {
    recipeDialog = el("dialog", {});
    document.body.append(recipeDialog);
  }
  const isEdit = !!name;
  const nameIn = el("input", { value: name || "", disabled: isEdit ? "" : null });
  const ingestIn = el("input", { value: (rcp && rcp.ingest) || "", placeholder: "#feed (default)" });
  const steps = (rcp && rcp.pipe) ? [...rcp.pipe] : [];
  const stepsBox = el("div", {});
  const err = el("div", { class: "muted" });

  function drawSteps() {
    stepsBox.replaceChildren();
    steps.forEach((s, i) => {
      const inp = el("input", { value: s, oninput: (e) => (steps[i] = e.target.value) });
      stepsBox.append(el("div", { class: "toolbar" }, inp,
        el("button", { class: "btn", onclick: () => { steps.splice(i, 1); drawSteps(); } }, "✕")));
    });
    stepsBox.append(el("button", { class: "btn", onclick: () => { steps.push(""); drawSteps(); } }, "+ step"));
  }
  drawSteps();

  const save = el("button", { class: "btn", onclick: async () => {
    const nm = (name || nameIn.value).trim();
    if (!nm) { err.textContent = "name required"; return; }
    const body = { ingest: ingestIn.value.trim(), pipe: steps.map((s) => s.trim()).filter(Boolean) };
    try {
      await api("PUT", "/api/recipes/" + encodeURIComponent(nm), body);
      recipeDialog.close();
      banner((isEdit ? "Updated " : "Created ") + "recipe " + nm, true);
      await renderRecipes();
    } catch (e) { err.textContent = e.message; }
  } }, "Save");

  recipeDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit recipe" : "New recipe"),
    el("label", {}, "Name"), nameIn,
    el("label", {}, "Ingest (blank = inherit default)"), ingestIn,
    el("label", {}, "Pipe steps"), stepsBox,
    err,
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => recipeDialog.close() }, "Cancel"), save));
  recipeDialog.showModal();
}

// --- inline preview (used inside the Recipes tab) ---------------------------
function previewPanel() {
  const url = el("input", { type: "url", placeholder: "https://example.com/feed", style: "min-width:24em" });
  const recipeSel = el("select", {}, el("option", { value: "default" }, "default"));
  apiGet("/api/recipes").then((rs) => {
    for (const n of Object.keys(rs).sort()) if (n !== "default") recipeSel.append(el("option", { value: n }, n));
  });
  const out = el("div", {});
  const go = el("button", { class: "btn", onclick: async () => {
    out.replaceChildren(el("div", { class: "muted" }, "loading…"));
    try {
      const arts = await apiGet(`/api/preview?url=${encodeURIComponent(url.value)}&recipe=${encodeURIComponent(recipeSel.value)}`);
      out.replaceChildren(el("div", { class: "muted" }, `${arts.length} articles`));
      for (const a of arts) {
        out.append(el("article", { class: "preview" },
          el("h4", {}, a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener" }, a.title) : a.title),
          el("div", { class: "content", html: a.content })));
      }
    } catch (e) { out.replaceChildren(el("div", { class: "muted" }, e.message)); }
  } }, "Preview");
  return el("div", {},
    el("h3", {}, "Preview a recipe against a URL"),
    el("div", { class: "toolbar" }, url, recipeSel, go), out);
}
```

> Note: preview renders pipeline-sanitized article HTML produced by the backend (`#sanitize`). Inserting it via `innerHTML` is consistent with `srr preview`'s own `rawHTML` template; both trust the same sanitizer.

- [ ] **Step 2: Upgrade the feed modal's recipe field to a populated dropdown**

In `openFeedModal` (added in Task 6), replace the line:

```javascript
  const recipe = el("input", { id: "f_recipe", value: v.recipe || "", placeholder: "default" });
```

with:

```javascript
  const recipe = el("select", { id: "f_recipe" }, el("option", { value: "" }, "default"));
  apiGet("/api/recipes").then((rs) => {
    for (const n of Object.keys(rs).sort()) {
      if (n === "default") continue;
      const o = el("option", { value: n }, n);
      if (n === (v.recipe || "")) o.selected = true;
      recipe.append(o);
    }
  });
```

(The `recipe.value.trim()` read in the save handler still works for a `<select>`.)

- [ ] **Step 3: Smoke test + manual verification**

Run: `cd backend && go test -run TestServeStaticAssets .` (confirms the JS still serves).
Then manual: `go build -o /tmp/srrb . && /tmp/srrb -o /tmp/srr-gui-store serve`, open the Recipes tab:
- `default` recipe listed; "+ New recipe" creates one with pipe steps; edit/delete work; delete on `default` is absent.
- Preview panel: enter a real feed URL, pick a recipe, "Preview" renders articles.
- Feeds tab → edit a feed → recipe field is now a dropdown listing your recipes.

- [ ] **Step 4: Commit**

```bash
git add backend/webui/app.js
git commit -m "feat(serve): Recipes tab UI + inline preview + recipe dropdown in feed modal"
```

**Phase 2 complete.** Recipes are manageable and testable against live URLs.

---

# Phase 3 — Tools: syndicate, gen, OPML, fetch, inspect

## Task 10: Syndicate endpoints (+ CLI refactor to share logic)

**Files:**
- Modify: `backend/cmd_syndicate.go` (extract `setOutFeed`/`removeOutFeed`; thin the commands)
- Create: `backend/serve_syndicate.go`
- Modify: `backend/cmd_serve.go` (routes)
- Create: `backend/serve_syndicate_test.go`

- [ ] **Step 1: Write the failing tests**

`backend/serve_syndicate_test.go`:

```go
package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestPutSyndicate(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "F", URL: "https://f.example/feed", Tag: "news"})

	body := `{"format":"rss","title":"My Feed","tags":["news"],"limit":10}`
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/mine", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/syndicate", "")
	var got []OutFeed
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 1 || got[0].Name != "mine" || got[0].Limit != 10 {
		t.Fatalf("got %+v", got)
	}
}

func TestPutSyndicateBadFormat(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"xml","tags":["a"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestPutSyndicateNoSelector(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestPutSyndicateUnknownFeed(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss","feeds":[77]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteSyndicate(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "F", URL: "https://f.example/feed", Tag: "news"})
	doReq(t, newMux(), "PUT", "/api/syndicate/mine", `{"format":"rss","tags":["news"]}`)
	rec := doReq(t, newMux(), "DELETE", "/api/syndicate/mine", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	list := doReq(t, newMux(), "GET", "/api/syndicate", "")
	var got []OutFeed
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 0 {
		t.Fatalf("not deleted: %+v", got)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run Syndicate .`
Expected: FAIL — `setOutFeed` undefined, routes missing.

- [ ] **Step 3: Extract the shared logic in `cmd_syndicate.go`**

Add to `backend/cmd_syndicate.go`:

```go
// setOutFeed validates and upserts one syndication output entry, reaping the
// orphaned old-extension file on a format change. Shared by `srr syndicate set`
// and the PUT handler. The caller supplies a fully-built OutFeed (Limit 0 ⇒
// default applied here).
func setOutFeed(ctx context.Context, db *DB, in OutFeed) error {
	if !validOutName(in.Name) {
		return fmt.Errorf("syndication name %q must match [A-Za-z0-9._-] and not be '.' or '..'", in.Name)
	}
	if in.Format != "rss" && in.Format != "json" {
		return fmt.Errorf("format %q is invalid; must be rss or json", in.Format)
	}
	if len(in.Tags) == 0 && len(in.Feeds) == 0 {
		return fmt.Errorf("at least one of tags or feeds must be non-empty")
	}
	for _, id := range in.Feeds {
		if _, err := db.FeedByID(id); err != nil {
			return fmt.Errorf("feed id %d: %w", id, err)
		}
	}
	if in.Limit <= 0 {
		in.Limit = outDefaultLimit
	}

	found := false
	oldFormat := ""
	for i, e := range db.core.Out {
		if e.Name == in.Name {
			oldFormat = e.Format
			db.core.Out[i] = in
			found = true
			break
		}
	}
	if !found {
		db.core.Out = append(db.core.Out, in)
	}
	if err := db.Commit(ctx); err != nil {
		return err
	}
	if found && oldFormat != "" && oldFormat != in.Format {
		_ = db.Rm(ctx, outFileKey(OutFeed{Name: in.Name, Format: oldFormat}))
	}
	return nil
}

// removeOutFeed deletes a syndication entry by name and best-effort removes its
// out/* files. Shared by `srr syndicate rm` and the DELETE handler.
func removeOutFeed(ctx context.Context, db *DB, name string) error {
	var format string
	out := db.core.Out[:0]
	for _, e := range db.core.Out {
		if e.Name == name {
			format = e.Format
			continue
		}
		out = append(out, e)
	}
	db.core.Out = out
	if err := db.Commit(ctx); err != nil {
		return err
	}
	exts := map[string]string{"rss": ".rss", "json": ".json"}
	if ext := exts[format]; format != "" && ext != "" {
		_ = db.Rm(ctx, "out/"+name+ext)
	} else {
		for _, ext := range exts {
			_ = db.Rm(ctx, "out/"+name+ext)
		}
	}
	return nil
}
```

Replace the body of `SyndicateSetCmd.Run`:

```go
func (o *SyndicateSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, OutFeed{
			Name:   o.Name,
			Title:  o.Title,
			Format: o.Format,
			Tags:   o.Tags,
			Feeds:  o.FeedIDs,
			Limit:  o.Limit,
		})
	})
}
```

Replace the body of `SyndicateRmCmd.Run`:

```go
func (o *SyndicateRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, o.Name)
	})
}
```

- [ ] **Step 4: Implement the handlers**

`backend/serve_syndicate.go`:

```go
package main

import (
	"context"
	"net/http"
)

func listSyndicate(w http.ResponseWriter, r *http.Request) {
	var out []OutFeed
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = append([]OutFeed(nil), db.core.Out...)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	if out == nil {
		out = []OutFeed{}
	}
	writeJSON(w, http.StatusOK, out)
}

func putSyndicate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title  string   `json:"title"`
		Format string   `json:"format"`
		Tags   []string `json:"tags"`
		Feeds  []int    `json:"feeds"`
		Limit  int      `json:"limit"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	entry := OutFeed{
		Name:   r.PathValue("name"),
		Title:  body.Title,
		Format: body.Format,
		Tags:   body.Tags,
		Feeds:  body.Feeds,
		Limit:  body.Limit,
	}
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, entry)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteSyndicate(w http.ResponseWriter, r *http.Request) {
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, r.PathValue("name"))
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
```

- [ ] **Step 5: Wire routes + run**

In `registerAPI`, add:

```go
	mux.HandleFunc("GET /api/syndicate", listSyndicate)
	mux.HandleFunc("PUT /api/syndicate/{name}", putSyndicate)
	mux.HandleFunc("DELETE /api/syndicate/{name}", deleteSyndicate)
```

Run: `cd backend && go test -run Syndicate .`
Expected: PASS (handler tests + existing `cmd_syndicate_test.go`).

- [ ] **Step 6: Commit**

```bash
git add backend/cmd_syndicate.go backend/serve_syndicate.go backend/cmd_serve.go backend/serve_syndicate_test.go
git commit -m "feat(serve): syndicate endpoints + share setOutFeed/removeOutFeed with CLI"
```

## Task 11: Gen + OPML import/export endpoints

**Files:**
- Modify: `backend/serve_tools.go` (`getGen`, `bumpGen`, `handleExport`, `handleImport`)
- Modify: `backend/cmd_serve.go` (routes)
- Modify: `backend/serve_tools_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/serve_tools_test.go`:

```go
func TestGenShowAndBump(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/gen", "")
	var g struct{ Gen int `json:"gen"` }
	json.Unmarshal(rec.Body.Bytes(), &g)
	if g.Gen != 0 {
		t.Fatalf("initial gen = %d, want 0", g.Gen)
	}
	bump := doReq(t, newMux(), "POST", "/api/gen/bump", "")
	if bump.Code != http.StatusOK {
		t.Fatalf("bump = %d (%s)", bump.Code, bump.Body)
	}
	json.Unmarshal(bump.Body.Bytes(), &g)
	if g.Gen != 1 {
		t.Fatalf("after bump gen = %d, want 1", g.Gen)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Alpha", URL: "https://a.example/feed", Tag: "news"})

	exp := doReq(t, newMux(), "GET", "/api/export", "")
	if exp.Code != http.StatusOK {
		t.Fatalf("export = %d", exp.Code)
	}
	opml := exp.Body.String()
	if !strings.Contains(opml, "https://a.example/feed") {
		t.Fatalf("export missing feed: %s", opml)
	}

	// Fresh store; import the exported OPML.
	setupTestDB(t)
	stubResolve(t)
	imp := doReqRaw(t, newMux(), "POST", "/api/import", opml)
	if imp.Code != http.StatusOK {
		t.Fatalf("import = %d (%s)", imp.Code, imp.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	if !strings.Contains(list.Body.String(), "https://a.example/feed") {
		t.Fatalf("imported feed not listed: %s", list.Body)
	}
}
```

`doReq` reads `body` as a string, which works for OPML too — but the OPML contains characters that are fine in a string. Add a raw alias for clarity in `cmd_serve_test.go`:

```go
func doReqRaw(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	return doReq(t, h, method, target, body)
}
```

Add `"strings"` and `"encoding/json"` to `serve_tools_test.go` imports if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run 'TestGen|TestExportImport' .`
Expected: FAIL — handlers/routes missing.

- [ ] **Step 3: Implement the handlers**

Append to `backend/serve_tools.go` (add imports: `encoding/xml`, `io`, `os`):

```go
func getGen(w http.ResponseWriter, r *http.Request) {
	var gen int
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		gen = db.core.Gen
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"gen": gen})
}

func bumpGen(w http.ResponseWriter, r *http.Request) {
	var gen int
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		db.BumpGen()
		gen = db.core.Gen
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"gen": gen})
}

func handleExport(w http.ResponseWriter, r *http.Request) {
	var data []byte
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		feeds := make([]*Feed, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			feeds = append(feeds, ch)
		}
		out, e := xml.MarshalIndent(buildOPML(feeds), "", "  ")
		if e != nil {
			return fmt.Errorf("encoding opml: %w", e)
		}
		data = append([]byte(xml.Header), out...)
		data = append(data, '\n')
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/x-opml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="srr-feeds.opml"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleImport imports every feed in the uploaded OPML body (like `srr import -a`).
// Optional query params: tag (override OPML group tags), recipe (stamp all),
// dry_run=1 (preview only). Subscribe-time discovery resolves homepage URLs.
func handleImport(w http.ResponseWriter, r *http.Request) {
	dryRun := r.URL.Query().Get("dry_run") == "1"
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, err)
		return
	}
	// ParseOPMLTree reads a path, so spill the body to a temp file.
	tmp, err := os.CreateTemp("", "srr-import-*.opml")
	if err != nil {
		writeErr(w, err)
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		writeErr(w, err)
		return
	}
	tmp.Close()

	nodes, err := ParseOPMLTree(tmp.Name())
	if err != nil {
		writeErr(w, err)
		return
	}
	iw := &importWalker{w: io.Discard, seen: map[string]bool{}}
	newFeeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		writeErr(w, err)
		return
	}

	var tag, recipe *string
	if q := r.URL.Query(); q.Has("tag") {
		v := q.Get("tag")
		tag = &v
	}
	if q := r.URL.Query(); q.Has("recipe") {
		v := q.Get("recipe")
		recipe = &v
	}
	applyImportDefaults(newFeeds, recipe, tag)

	recipes, err := importRecipes()
	if err != nil {
		writeErr(w, err)
		return
	}
	if recipe != nil {
		if err := validateRecipeRef(recipes, *recipe); err != nil {
			writeErr(w, err)
			return
		}
	}
	kept, failed := resolveImportFeeds(r.Context(), newFeeds, recipes)

	type skip struct {
		Title string `json:"title"`
		URL   string `json:"url"`
		Error string `json:"error"`
	}
	skips := make([]skip, 0, len(failed))
	for _, f := range failed {
		skips = append(skips, skip{Title: f.Title, URL: f.URL, Error: f.Err.Error()})
	}

	if dryRun {
		previews := make([]feedView, 0, len(kept))
		for _, c := range kept {
			previews = append(previews, feedView{Title: c.Title, URL: c.URL, Tag: c.Tag, Recipe: c.Recipe})
		}
		writeJSON(w, http.StatusOK, map[string]any{"feeds": previews, "skipped": skips})
		return
	}

	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		for _, c := range kept {
			if err := normalizeFeed(c, db.core.Recipes); err != nil {
				return err
			}
			if err := db.AddFeed(c); err != nil {
				return err
			}
		}
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": len(kept), "skipped": skips})
}
```

- [ ] **Step 4: Wire routes + run**

In `registerAPI`, add:

```go
	mux.HandleFunc("GET /api/gen", getGen)
	mux.HandleFunc("POST /api/gen/bump", bumpGen)
	mux.HandleFunc("GET /api/export", handleExport)
	mux.HandleFunc("POST /api/import", handleImport)
```

Run: `cd backend && go test -run 'TestGen|TestExportImport' .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/serve_tools.go backend/cmd_serve.go backend/serve_tools_test.go
git commit -m "feat(serve): gen show/bump + OPML import/export endpoints"
```

## Task 12: Refactor the fetch driver (filter + progress callback)

**Files:**
- Modify: `backend/cmd_fetch.go`
- Create: `backend/serve_fetch_test.go` (driver test; SSE test added in Task 13)

- [ ] **Step 1: Write the failing test**

`backend/serve_fetch_test.go`:

```go
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"srrb/mod"
)

func rssServer(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS)) // defined in serve_tools_test.go
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func allowLoopback(t *testing.T) {
	t.Helper()
	prev := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prev })
}

func TestRunFetchAllAndProgress(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	var seen []feedProgress
	err := (&FetchCmd{}).runFetch(ctx, newFetchClient(1), nil, func(p feedProgress) {
		seen = append(seen, p)
	})
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if len(seen) != 1 || seen[0].New != 1 {
		t.Fatalf("progress = %+v, want one feed with 1 new", seen)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 1 {
			t.Fatalf("TotalArticles = %d, want 1", d.core.TotalArticles)
		}
		return nil
	})
}

func TestRunFetchFilterExcludes(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	var seen []feedProgress
	// Filter matches no feed (id 999).
	err := (&FetchCmd{}).runFetch(ctx, newFetchClient(1), func(ch *Feed) bool { return ch.id == 999 },
		func(p feedProgress) { seen = append(seen, p) })
	if err != nil {
		t.Fatalf("runFetch: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("progress = %+v, want none", seen)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		if d.core.TotalArticles != 0 {
			t.Fatalf("TotalArticles = %d, want 0 (filtered out)", d.core.TotalArticles)
		}
		return nil
	})
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run TestRunFetch .`
Expected: FAIL — `runFetch`/`feedProgress` undefined.

- [ ] **Step 3: Refactor `cmd_fetch.go`**

In `backend/cmd_fetch.go`:

(a) Add the progress type near the top (after the `FetchCmd` struct):

```go
// feedProgress reports one feed's outcome to a runFetch caller (the SSE handler).
type feedProgress struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Error string `json:"error,omitempty"`
	New   int    `json:"new"`
}
```

(b) Change the `Run` method's two call sites of `o.fetch(ctx, client)` to `o.runFetch(ctx, client, nil, nil)`. (There are two: inside the `--interval` loop and the final `return`.)

(c) Rename the method signature:

```go
func (o *FetchCmd) fetch(ctx context.Context, client *http.Client) error {
```

to:

```go
// runFetch runs one fetch cycle over the feeds matching filter (nil = all),
// invoking onFeed (if non-nil) once per feed as it finishes. onFeed may run
// concurrently from worker goroutines — callers must guard it. The CLI passes
// (nil, nil); the SSE handler passes a feed filter and a channel-pushing onFeed.
func (o *FetchCmd) runFetch(ctx context.Context, client *http.Client, filter func(*Feed) bool, onFeed func(feedProgress)) error {
```

(d) In the feed loop, change:

```go
		for _, ch := range db.Feeds() {
			if ctx.Err() != nil {
				break
			}
			g.Go(func() error {
				buf := bufPool.Get().([]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				ch.Fetch(gctx, run, buf, processor)
				return nil
			})
		}
```

to:

```go
		for _, ch := range db.Feeds() {
			if filter != nil && !filter(ch) {
				continue
			}
			if ctx.Err() != nil {
				break
			}
			g.Go(func() error {
				buf := bufPool.Get().([]byte)
				defer bufPool.Put(buf)
				processor := procPool.Get().(*mod.Module)
				defer procPool.Put(processor)
				ch.Fetch(gctx, run, buf, processor)
				if onFeed != nil {
					onFeed(feedProgress{ID: ch.id, Title: ch.Title, Error: ch.FetchError, New: len(ch.newItems)})
				}
				return nil
			})
		}
```

(Everything else in the method — the article gather, `PutArticles`, sync steps, `Commit`, GC — is unchanged; filtered-out feeds simply contribute no `newItems`.)

- [ ] **Step 4: Run to verify pass + existing fetch tests green**

Run: `cd backend && go test -run 'TestRunFetch|TestFetch|TestCmdFetch' . && go test .`
Expected: PASS (new driver tests + existing `cmd_fetch_test.go`).

- [ ] **Step 5: Commit**

```bash
git add backend/cmd_fetch.go backend/serve_fetch_test.go
git commit -m "refactor(fetch): runFetch(filter, onFeed) — drive CLI and the GUI from one path"
```

## Task 13: SSE fetch endpoint

**Files:**
- Create: `backend/serve_fetch.go`
- Modify: `backend/cmd_serve.go` (route)
- Modify: `backend/serve_fetch_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/serve_fetch_test.go` (add `"io"`, `"strings"`, `"os"` to imports):

```go
func TestFetchSSE(t *testing.T) {
	db, _, _ := setupTestDB(t)
	allowLoopback(t)
	seedFeed(t, db, &Feed{Title: "Live", URL: rssServer(t)})

	srv := httptest.NewServer(newMux())
	t.Cleanup(srv.Close)
	res, err := http.Post(srv.URL+"/api/fetch", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	s := string(body)
	if !strings.Contains(s, "event: feed") {
		t.Fatalf("stream missing feed event:\n%s", s)
	}
	if !strings.Contains(s, "event: done") {
		t.Fatalf("stream missing done event:\n%s", s)
	}
}

func TestFetchSSELockContention(t *testing.T) {
	_, _, dir := setupTestDB(t)
	if err := os.WriteFile(dir+"/"+dbLockKey, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newMux())
	t.Cleanup(srv.Close)
	res, err := http.Post(srv.URL+"/api/fetch", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "event: error") || !strings.Contains(string(body), "locked") {
		t.Fatalf("expected in-band lock error event, got:\n%s", body)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test -run TestFetchSSE .`
Expected: FAIL — route/handler missing.

- [ ] **Step 3: Implement the SSE handler**

`backend/serve_fetch.go`:

```go
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
)

// handleFetch runs one fetch cycle and streams per-feed progress as SSE. An
// optional ?feed=<id> restricts the cycle to one feed. The triggered fetch holds
// the store lock for its duration (like `srr art fetch`); if another process
// holds it, the stream carries an in-band `event: error` (SSE has already sent
// 200, so contention can't be a 409 here).
func handleFetch(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, fmt.Errorf("streaming unsupported"))
		return
	}
	var filter func(*Feed) bool
	if fid := r.URL.Query().Get("feed"); fid != "" {
		id, err := strconv.Atoi(fid)
		if err != nil {
			writeErr(w, fmt.Errorf("invalid feed id %q", fid))
			return
		}
		filter = func(ch *Feed) bool { return ch.id == id }
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	progress := make(chan feedProgress, 64)
	done := make(chan error, 1)
	go func() {
		client := newFetchClient(globals.Workers)
		err := (&FetchCmd{}).runFetch(r.Context(), client, filter, func(p feedProgress) {
			progress <- p
		})
		done <- err
		close(progress)
	}()

	for p := range progress {
		writeSSE(w, flusher, "feed", p)
	}
	if err := <-done; err != nil {
		msg := err.Error()
		if errors.Is(err, os.ErrExist) {
			msg = "store is locked by another srr process — the fetch loop may be running; try again"
		}
		writeSSE(w, flusher, "error", map[string]string{"error": msg})
		return
	}
	writeSSE(w, flusher, "done", map[string]string{"status": "ok"})
}

func writeSSE(w http.ResponseWriter, f http.Flusher, event string, v any) {
	data, _ := json.Marshal(v)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
	f.Flush()
}
```

- [ ] **Step 4: Wire the route + run**

In `registerAPI`, add:

```go
	mux.HandleFunc("POST /api/fetch", handleFetch)
```

Run: `cd backend && go test -run TestFetchSSE .`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/serve_fetch.go backend/cmd_serve.go backend/serve_fetch_test.go
git commit -m "feat(serve): POST /api/fetch — SSE progress, lock contention in-band"
```

## Task 14: Inspect endpoint

The inspect reports in `cmd_inspect_report.go`/`cmd_inspect_check.go` print to stdout. Rather than refactor them to return structured data (large change, out of scope), the handler runs the report by capturing the existing stdout-printing path and returns it as `{"report": "<text>"}`. This reuses the validated logic verbatim.

**Files:**
- Modify: `backend/serve_tools.go` (`handleInspect`)
- Modify: `backend/cmd_serve.go` (route)
- Modify: `backend/serve_tools_test.go`

Confirmed against `cmd_inspect.go`: `InspectCmd` has fields `Validate bool` and `FromHash string`, and `Run()` dispatches `if o.Validate { … }` and `if o.FromHash != "" { … }` **before** the `Chron` branch — so a manually-built `&InspectCmd{Validate: true}` (where `Chron` is the zero value `0`, not the kong `-1` default) still routes correctly. The handler sets only `Validate`/`FromHash` and calls `Run()`; it does not touch `cmd_inspect*.go`.

- [ ] **Step 1: Write the failing test**

Append to `backend/serve_tools_test.go`:

```go
func TestInspectValidate(t *testing.T) {
	setupTestDB(t) // empty store is internally consistent
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=validate", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got struct {
		Report string `json:"report"`
		OK     bool   `json:"ok"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.OK {
		t.Fatalf("empty store should validate ok; report:\n%s", got.Report)
	}
}

func TestInspectBadMode(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/inspect?mode=bogus", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Implement the handler**

The handler captures whatever the existing inspect code prints to the package-level `stdout` (`cmd_feeds.go` defines `var stdout io.Writer = os.Stdout`; the inspect reports print via `fmt.Printf`, i.e. to the real stdout). To capture reliably, run inspect through `InspectCmd` with its fields set and **redirect `os.Stdout`** for the duration. Implement in `backend/serve_tools.go` (add imports `bytes`, `strings`):

```go
// handleInspect runs `srr inspect` in-process for the supported GUI modes
// (validate, from-hash) and returns its textual report. It reuses InspectCmd by
// capturing os.Stdout for the call — the report functions print via fmt.Printf.
func handleInspect(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	cmd := &InspectCmd{}
	switch mode {
	case "validate":
		cmd.Validate = true
	case "from-hash":
		hash := r.URL.Query().Get("hash")
		if hash == "" {
			writeErr(w, fmt.Errorf("hash is required for mode=from-hash"))
			return
		}
		cmd.FromHash = hash
	default:
		writeErr(w, fmt.Errorf("unsupported mode %q (use validate or from-hash)", mode))
		return
	}

	report, runErr := captureStdout(func() error { return cmd.Run() })
	writeJSON(w, http.StatusOK, map[string]any{
		"report": report,
		"ok":     runErr == nil,
		"error":  errString(runErr),
	})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// captureStdout redirects os.Stdout to a pipe for the duration of fn and returns
// what was written. Serialized by serveStdoutMu so concurrent inspect calls do
// not interleave (inspect is a rare, operator-driven action).
var serveStdoutMu = make(chan struct{}, 1)

func captureStdout(fn func() error) (string, error) {
	serveStdoutMu <- struct{}{}
	defer func() { <-serveStdoutMu }()

	orig := os.Stdout
	rd, wr, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = wr
	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(rd)
		out <- buf.String()
	}()

	runErr := fn()
	wr.Close()
	os.Stdout = orig
	return <-out, runErr
}
```

> `InspectCmd.Run` reads `globals.Store` and opens the store read-only, matching how `srr inspect` works against `--store`.

- [ ] **Step 3: Wire the route + run**

In `registerAPI`, add:

```go
	mux.HandleFunc("GET /api/inspect", handleInspect)
```

Run: `cd backend && go test -run TestInspect .`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/serve_tools.go backend/cmd_serve.go backend/serve_tools_test.go
git commit -m "feat(serve): GET /api/inspect (validate, from-hash) via captured report"
```

## Task 15: Syndicate tab + Tools tab + OPML buttons UI

**Files:**
- Modify: `backend/webui/app.js` (syndicate + tools modules; OPML buttons; SSE stream helper)

- [ ] **Step 1: Add an SSE-over-fetch helper near the top of `backend/webui/app.js`**

Add right after the `api`/`apiGet` helpers:

```javascript
// streamSSE POSTs to path and invokes onEvent({event, data}) for each SSE frame.
async function streamSSE(path, onEvent) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) throw new Error(res.statusText);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      onEvent({ event: ev, data: data ? JSON.parse(data) : null });
    }
  }
}
```

- [ ] **Step 2: Append the syndicate module**

```javascript
// --- syndicate tab ----------------------------------------------------------
async function renderSyndicate() {
  const outs = await apiGet("/api/syndicate");
  const root = document.getElementById("syndicate");
  root.replaceChildren(el("div", { class: "toolbar" },
    el("button", { class: "btn", onclick: () => openOutModal(null) }, "+ New output")));
  if (!outs.length) {
    root.append(el("div", { class: "muted" }, "No syndication outputs. (Writing them needs SRR_CDN_URL set on the fetch loop.)"));
  }
  const table = el("table", {}, el("thead", {}, el("tr", {},
    el("th", {}, "name"), el("th", {}, "format"), el("th", {}, "tags"),
    el("th", {}, "feeds"), el("th", {}, "limit"), el("th", {}, ""))));
  const tb = el("tbody", {});
  for (const o of outs) {
    tb.append(el("tr", {},
      el("td", {}, o.name),
      el("td", {}, o.format),
      el("td", {}, (o.tags || []).join(", ")),
      el("td", {}, (o.feeds || []).join(", ")),
      el("td", {}, String(o.limit || "")),
      el("td", {},
        el("button", { class: "btn", onclick: () => openOutModal(o) }, "edit"), " ",
        el("button", { class: "btn", onclick: () => deleteOut(o.name) }, "✕"))));
  }
  table.append(tb);
  root.append(table);
}
renderers.syndicate = renderSyndicate;

async function deleteOut(name) {
  if (!confirm(`Delete output “${name}”?`)) return;
  try { await api("DELETE", "/api/syndicate/" + encodeURIComponent(name)); await renderSyndicate(); }
  catch (e) { banner(e.message); }
}

let outDialog;
function openOutModal(o) {
  if (!outDialog) { outDialog = el("dialog", {}); document.body.append(outDialog); }
  const isEdit = !!o;
  const v = o || { name: "", title: "", format: "rss", tags: [], feeds: [], limit: 50 };
  const name = el("input", { value: v.name, disabled: isEdit ? "" : null });
  const fmt = el("select", {}, el("option", { value: "rss" }, "rss"), el("option", { value: "json" }, "json"));
  fmt.value = v.format;
  const title = el("input", { value: v.title || "" });
  const tags = el("input", { value: (v.tags || []).join(","), placeholder: "comma-separated tags" });
  const feeds = el("input", { value: (v.feeds || []).join(","), placeholder: "comma-separated feed ids" });
  const limit = el("input", { type: "number", value: v.limit || 50 });
  const err = el("div", { class: "muted" });
  const save = el("button", { class: "btn", onclick: async () => {
    const nm = (v.name || name.value).trim();
    const body = {
      title: title.value.trim(), format: fmt.value,
      tags: tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      feeds: feeds.value.split(",").map((s) => s.trim()).filter(Boolean).map(Number),
      limit: Number(limit.value) || 0,
    };
    try {
      await api("PUT", "/api/syndicate/" + encodeURIComponent(nm), body);
      outDialog.close(); banner("Saved output " + nm, true); await renderSyndicate();
    } catch (e) { err.textContent = e.message; }
  } }, "Save");
  outDialog.replaceChildren(
    el("h3", {}, isEdit ? "Edit output" : "New output"),
    el("label", {}, "Name"), name,
    el("label", {}, "Format"), fmt,
    el("label", {}, "Title"), title,
    el("label", {}, "Tags"), tags,
    el("label", {}, "Feed ids"), feeds,
    el("label", {}, "Limit"), limit,
    err,
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: () => outDialog.close() }, "Cancel"), save));
  outDialog.showModal();
}
```

- [ ] **Step 3: Append the tools module**

```javascript
// --- tools tab --------------------------------------------------------------
async function renderTools() {
  const root = document.getElementById("tools");
  root.replaceChildren();

  // Fetch
  const feeds = await apiGet("/api/feeds");
  const feedSel = el("select", {}, el("option", { value: "" }, "all feeds"));
  for (const f of feeds) feedSel.append(el("option", { value: f.id }, `#${f.id} ${f.title}`));
  const log = el("pre", { class: "log" });
  const fetchBtn = el("button", { class: "btn", onclick: async () => {
    log.textContent = "";
    const q = feedSel.value ? "?feed=" + encodeURIComponent(feedSel.value) : "";
    fetchBtn.disabled = true;
    try {
      await streamSSE("/api/fetch" + q, ({ event, data }) => {
        if (event === "feed") log.textContent += `#${data.id} ${data.title}: ${data.error ? "ERROR " + data.error : data.new + " new"}\n`;
        else if (event === "done") log.textContent += "done.\n";
        else if (event === "error") log.textContent += "ERROR: " + data.error + "\n";
      });
    } catch (e) { log.textContent += "stream error: " + e.message + "\n"; }
    fetchBtn.disabled = false;
  } }, "Fetch now");
  root.append(el("h3", {}, "Fetch"),
    el("div", { class: "toolbar" }, feedSel, fetchBtn), log);

  // Gen
  const g = await apiGet("/api/gen");
  const genLabel = el("span", {}, "generation: " + g.gen);
  const bumpBtn = el("button", { class: "btn", onclick: async () => {
    if (!confirm("Bump the store generation? This forces every reader's service worker to purge its pack cache.")) return;
    try { const r = await api("POST", "/api/gen/bump"); genLabel.textContent = "generation: " + r.gen; banner("Bumped to " + r.gen, true); }
    catch (e) { banner(e.message); }
  } }, "Bump generation");
  root.append(el("h3", {}, "Generation"), el("div", { class: "toolbar" }, genLabel, bumpBtn));

  // Inspect
  const out = el("pre", { class: "log" });
  const hashIn = el("input", { placeholder: "hash e.g. 0,2485!big_info", style: "min-width:18em" });
  const runInspect = async (mode, extra) => {
    out.textContent = "running…";
    try { const r = await apiGet(`/api/inspect?mode=${mode}${extra || ""}`); out.textContent = (r.ok ? "" : "FAILED: " + (r.error || "") + "\n\n") + r.report; }
    catch (e) { out.textContent = e.message; }
  };
  root.append(el("h3", {}, "Inspect"),
    el("div", { class: "toolbar" },
      el("button", { class: "btn", onclick: () => runInspect("validate") }, "Validate store"),
      hashIn,
      el("button", { class: "btn", onclick: () => runInspect("from-hash", "&hash=" + encodeURIComponent(hashIn.value)) }, "From hash")),
    out);
}
renderers.tools = renderTools;
```

- [ ] **Step 4: Add OPML Import/Export buttons to the Feeds toolbar**

In `drawFeeds` (Task 6), change the toolbar append line:

```javascript
  root.append(el("div", { class: "toolbar" }, search, tagSel, add));
```

to:

```javascript
  const exportBtn = el("button", { class: "btn", onclick: () => { window.location = "/api/export"; } }, "Export OPML");
  const importInput = el("input", { type: "file", accept: ".opml,.xml,text/xml", style: "display:none",
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await fetch("/api/import", { method: "POST", body: text });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        banner(`Imported ${data.imported}, skipped ${data.skipped.length}`, true);
        await renderFeeds();
      } catch (err) { banner(err.message); }
      e.target.value = "";
    } });
  const importBtn = el("button", { class: "btn", onclick: () => importInput.click() }, "Import OPML");
  root.append(el("div", { class: "toolbar" }, search, tagSel, add, importBtn, importInput, exportBtn));
```

- [ ] **Step 5: Smoke test + manual verification**

Run: `cd backend && go test -run TestServeStaticAssets .`
Then manual (`/tmp/srrb -o /tmp/srr-gui-store serve`):
- **Syndicate**: "+ New output" → name/format/tags → saves and lists; edit/delete work.
- **Tools → Fetch**: "Fetch now" streams a per-feed line then "done." (add a real feed first; SSRF guard blocks LAN/loopback feeds unless `SRR_ALLOW_PRIVATE_FETCH=1`).
- **Tools → Generation**: shows the number; "Bump" increments after confirm.
- **Tools → Inspect**: "Validate store" prints the report.
- **Feeds**: "Export OPML" downloads `srr-feeds.opml`; "Import OPML" uploads it back and reports counts.

- [ ] **Step 6: Commit**

```bash
git add backend/webui/app.js
git commit -m "feat(serve): Syndicate + Tools tabs, SSE fetch log, OPML import/export buttons"
```

**Phase 3 complete.** The full management surface is in the GUI.

## Task 16: Full verification + docs

**Files:**
- Modify: `backend/CLAUDE.md` (document `serve`)
- Modify: root `CLAUDE.md` command table is not required (backend-local); update `backend/CLAUDE.md` only.

- [ ] **Step 1: Run the full backend gate**

Run: `cd /home/gllera/ws/srr && make verify-be`
Expected: PASS (vet + gofmt check + build + test + generate-check). `generate-check` must stay green — no data-contract atoms changed, so `format.gen.ts` is unaffected. If gofmt flags any new file, run `make format-be` and re-commit.

- [ ] **Step 2: Document the command in `backend/CLAUDE.md`**

Add a bullet under the Architecture list (after the `cmd_preview.go` bullet):

```markdown
- **`cmd_serve.go` / `serve_feeds.go` / `serve_recipes.go` / `serve_syndicate.go` / `serve_fetch.go` / `serve_tools.go`** — `ServeCmd` (`srr serve`): a localhost web admin GUI. Serves an embedded `webui/` bundle (`//go:embed`) at `/` and a JSON API under `/api/*`. Each handler opens its own `withDB` scope per request — read-only (no lock) for GET, `withDB(true)` (acquire→commit→release) for mutations; no persistent lock or DB handle. A Host/Origin loopback allowlist (`hostGuard`) blocks cross-origin access to the mutating API; binds `localhost:8088` by default (`--addr`/`SRR_SERVE_ADDR`). Reuses CLI logic via shared helpers: `saveFeed` (feed upsert + subscribe-time discovery), `setRecipe`/`removeRecipe` (also back `srr recipe`), `setOutFeed`/`removeOutFeed` (also back `srr syndicate`), `renderPreview` (also backs `srr preview`), and `FetchCmd.runFetch(filter, onFeed)` (also backs `srr art fetch`; the SSE `/api/fetch` streams per-feed progress). Lock contention → 409 (`os.ErrExist`); a triggered fetch holds the lock for its duration like the cron loop. `/api/inspect` captures the existing `srr inspect` report.
```

Also add `serve` to the command-groups line in the `main.go` bullet (append `; serve`).

- [ ] **Step 3: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "docs(backend): document srr serve web admin GUI"
```

- [ ] **Step 4: Final manual end-to-end pass**

```bash
cd backend && go build -o /tmp/srrb .
/tmp/srrb -o /tmp/srr-gui-store serve
```
Walk all four tabs once more against a scratch store; confirm no console errors and every action round-trips. Stop with Ctrl-C (graceful shutdown prints nothing and exits 0).

---

## Self-review notes (for the implementer)

- **Routing precedence (Go 1.22+ ServeMux):** `POST /api/feeds/apply` is a literal and wins over `GET/PUT/DELETE /api/feeds/{id}` (different methods); `POST /api/feeds` matches only the bare path. No pattern conflicts.
- **SSRF guard in tests:** any test that actually fetches (preview, runFetch, SSE) must set `mod.AllowPrivateFetch = true` because `newFetchClient`/preview dial loopback httptest servers. Restore it via `t.Cleanup`.
- **Lock detection is `errors.Is(err, os.ErrExist)`** — exact for the local store (`O_EXCL`). An S3/R2 precondition failure won't match and surfaces as 400/500 with the underlying message; that's acceptable (the message still names the lock), and the realistic GUI-contention case is a local store.
- **`decodeJSON` is lenient** (no `DisallowUnknownFields`) so a client echoing back extra read-only fields (e.g. health fields on a feed PUT) doesn't 400. The UI sends only the writable subset anyway.
- **Preview/inspect HTML** is inserted via `innerHTML` — it is backend-`#sanitize`d content, the same trust model as `srr preview`'s `rawHTML` template.
- **`captureStdout` serializes** inspect calls via a 1-slot channel; inspect is operator-driven and rare, so global `os.Stdout` redirection is safe here.
