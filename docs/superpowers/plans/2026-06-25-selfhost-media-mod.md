# `#selfhost` Media Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `#selfhost` pipeline mod that downloads an item's remote `<img>`/`<video>`/`<audio>` media into the run's shared cache dir and rewrites each reference to a `#`-marker, so SRR's existing peek → `SRR_ASSET_PROCESS` → content-hash upload step converts and self-hosts it.

**Architecture:** The mod is thin — it only does download-and-mark. Conversion, dedup, SSRF, and upload-to-`assets/` are reused unchanged. The mod reaches the run's cache dir through a new `context.Value` set in `feed.go`. The shared HTML attribute walk behind the existing upload step is extracted so the mod and the upload step share one parser. `<audio>` is newly allowed through both sanitizers (backend bluemonday + frontend `fmt.ts`), kept in parity, with the frontend forcing `controls` so self-hosted audio is playable.

**Tech Stack:** Go (backend `mod/`, `feed.go`, `store/`), TypeScript (frontend `fmt.ts`), `golang.org/x/net/html`, `go test`, `vitest`.

---

## Spec

Design: `docs/superpowers/specs/2026-06-25-selfhost-media-mod-design.md`. Read it before starting.

## File Structure

| File | Responsibility |
|---|---|
| `backend/mod/helper_assets.go` | (modify) Cache-dir context helpers (`WithCacheDir`/`cacheDirFromContext`); extract the shared `walkAssetAttrs`/`walkNode` HTML walk; `RewriteAttrs` delegates to it; add `audio:[src]` to `assetAttrs`; add the `mediaAttrs` set. |
| `backend/mod/selfhost.go` | (create) The `#selfhost` built-in: SSRF-guarded download of remote media into the cache dir + marker rewrite, fail-open per asset. |
| `backend/mod/selfhost_test.go` | (create) `#selfhost` unit tests (download+mark, dedup, fail-open, no-cache-dir, params, untouched targets). |
| `backend/mod/sanitize.go` | (modify) Allow `<audio>` + `src`/`controls`/`preload`. |
| `backend/mod/sanitize_test.go` | (create) `<audio>` allow/strip parity cases. |
| `backend/feed.go` | (modify) One line: stamp the run cache dir onto the fetch context in `Feed.Fetch`. |
| `backend/feed_test.go` | (modify) Main-package round-trip: `#selfhost` marker → `UploadCacheRef` → `assets/…` key. |
| `frontend/src/js/fmt.ts` | (modify) `AUDIO` branch in `sanitizeHtml`: force `controls`, resolve `src` against the pack base. |
| `frontend/src/js/fmt.test.ts` | (modify) `<audio>` sanitize/resolve/force-controls cases. |
| `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `backend/README.md` | (modify) Document the mod, the `<audio>` parity change, and limitations. |

---

### Task 1: Cache-dir context plumbing (`mod/`)

A `Processor` is `func(context.Context, Params, *RawItem) error` — no handle to the run's cache dir. Carry it through the fetch context.

**Files:**
- Modify: `backend/mod/helper_assets.go`
- Test: `backend/mod/helper_assets_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/mod/helper_assets_test.go`:

```go
func TestCacheDirContextRoundTrips(t *testing.T) {
	ctx := WithCacheDir(context.Background(), "/tmp/run-cache")
	if got := cacheDirFromContext(ctx); got != "/tmp/run-cache" {
		t.Errorf("cacheDirFromContext = %q, want %q", got, "/tmp/run-cache")
	}
	if got := cacheDirFromContext(context.Background()); got != "" {
		t.Errorf("absent cache dir = %q, want empty string", got)
	}
}
```

Add `"context"` to the test file's import block (currently `fmt`, `strings`, `testing`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./mod/ -run TestCacheDirContextRoundTrips`
Expected: FAIL — `undefined: WithCacheDir` / `undefined: cacheDirFromContext`.

- [ ] **Step 3: Add the helpers**

Add `"context"` to the import block of `backend/mod/helper_assets.go` (currently `regexp`, `strings`, `golang.org/x/net/html`, `golang.org/x/net/html/atom`), and append:

```go
// cacheDirKey is the unexported context key carrying the fetch run's shared
// asset cache dir. main.Feed.Fetch stamps it via WithCacheDir; #selfhost reads
// it via cacheDirFromContext. A run-scoped working directory crossing the
// main->mod boundary is a legitimate context.Value use; an absent value (e.g.
// srr preview, the Validate sentinel) reads back as "" and #selfhost no-ops.
type cacheDirKey struct{}

// WithCacheDir returns ctx with the fetch run's shared cache dir attached.
func WithCacheDir(ctx context.Context, dir string) context.Context {
	return context.WithValue(ctx, cacheDirKey{}, dir)
}

// cacheDirFromContext returns the cache dir stamped by WithCacheDir, or "" when
// none is set.
func cacheDirFromContext(ctx context.Context) string {
	dir, _ := ctx.Value(cacheDirKey{}).(string)
	return dir
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./mod/ -run TestCacheDirContextRoundTrips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/mod/helper_assets.go backend/mod/helper_assets_test.go
git commit -m "feat(mod): carry the fetch run cache dir through context

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 2: Extract `walkAssetAttrs`; `RewriteAttrs` delegates; add `audio`

Both the upload step and `#selfhost` walk asset attributes. Extract one parser; keep `RewriteAttrs` behavior byte-for-byte. Add `audio:[src]` to the upload set and a narrower `mediaAttrs` download set.

**Files:**
- Modify: `backend/mod/helper_assets.go`
- Test: `backend/mod/helper_assets_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/mod/helper_assets_test.go`:

```go
// walkAssetAttrs visits EVERY listed attribute (not just "#"-markers); the
// callback decides. Here it uppercases each img/video/audio src to prove the
// generic walk + selective rewrite + no-op-preserves-original behavior.
func TestWalkAssetAttrsRewritesSelected(t *testing.T) {
	in := `<img src="a"><video src="b"></video><audio src="c"></audio><a href="d">x</a>`
	out, err := walkAssetAttrs(in, mediaAttrs, func(tag, attr, val string) (string, bool, error) {
		return strings.ToUpper(val), true, nil
	})
	if err != nil {
		t.Fatalf("walkAssetAttrs: %v", err)
	}
	for _, want := range []string{`src="A"`, `src="B"`, `src="C"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
	// mediaAttrs does NOT include <a href>, so the link is untouched.
	if !strings.Contains(out, `href="d"`) {
		t.Errorf("anchor href should be untouched: %s", out)
	}
}

func TestWalkAssetAttrsNoMatchReturnsOriginal(t *testing.T) {
	in := `<p>no media here</p>`
	out, err := walkAssetAttrs(in, mediaAttrs, func(_, _, _ string) (string, bool, error) {
		t.Fatal("fn must not be called when no listed attribute is present")
		return "", false, nil
	})
	if err != nil || out != in {
		t.Errorf("got (%q, %v), want original unchanged", out, err)
	}
}

// assetAttrs now covers <audio src>, so the upload step rewrites an audio marker.
func TestRewriteAttrsCoversAudio(t *testing.T) {
	out, err := RewriteAttrs(`<audio src="#/clip.mp3"></audio>`, upMarker("assets/zz"))
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if !strings.Contains(out, "assets/zz/clip.mp3") {
		t.Errorf("audio marker not rewritten: %s", out)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./mod/ -run 'TestWalkAssetAttrs|TestRewriteAttrsCoversAudio'`
Expected: FAIL — `undefined: walkAssetAttrs`, `undefined: mediaAttrs`, and the audio marker not rewritten.

- [ ] **Step 3: Refactor `helper_assets.go`**

Replace the `assetAttrs` block, `RewriteAttrs`, and `applyAttrs` with the following (the `mediaAttrs` set is new; `walkAssetAttrs`/`walkNode` replace `applyAttrs`; `RewriteAttrs` keeps its fast-path and delegates):

```go
// assetAttrs lists every element/attribute pair whose value the END-OF-PIPELINE
// UPLOAD STEP may rewrite from a "#"-marker to an assets/ key: embedded media
// plus <a href> (linked files). Every entry must be one the sanitizer keeps
// (mod/sanitize.go) or the rewritten key would be stripped before storage.
var assetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
	"a":     {"href"},
}

// mediaAttrs is the subset #selfhost DOWNLOADS: embedded-media src/poster only,
// NOT <a href> (a link is navigation, not auto-loaded media). <video poster>
// self-hosts because #selfhost runs after #sanitize (see the design's placement
// section), so the marker it writes is never re-sanitized.
var mediaAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
}

// RewriteAttrs walks the assetAttrs values in content and rewrites their
// "#"-prefixed upload markers via fn (the "#" already stripped). Non-marker
// values never reach fn. Unparseable content and a no-op pass both return the
// original string verbatim. It is the asset-upload walk behind the
// end-of-pipeline step in main.Feed.fetch: fn owns the upload policy.
func RewriteAttrs(content string, fn func(marker string) (string, bool, error)) (string, error) {
	// A marker is always a whole attribute value, so content without the
	// `=["']?#` shape can hold none: skip the parse entirely (memchr-speed
	// common case — #feed feeds never emit markers).
	if !strings.Contains(content, "#") || !markerShapeRe.MatchString(content) {
		return content, nil
	}
	return walkAssetAttrs(content, assetAttrs, func(_, _, val string) (string, bool, error) {
		if !strings.HasPrefix(val, "#") {
			return "", false, nil
		}
		return fn(strings.TrimPrefix(val, "#"))
	})
}

// walkAssetAttrs parses content as an HTML fragment and calls fn(tag, attr,
// value) for every attribute listed in attrs (tag -> attr names). fn returns
// (newValue, true, nil) to replace the value, (_, false, nil) to leave it, or a
// non-nil error to abort the walk. Unparseable content and a no-op pass both
// return content verbatim (no re-render), so quoting/whitespace survive when
// nothing changed; an fn or render error is returned with an empty string. It
// is the shared HTML walk behind both the upload step (RewriteAttrs, marker ->
// key) and #selfhost (URL -> marker).
func walkAssetAttrs(content string, attrs map[string][]string, fn func(tag, attr, val string) (string, bool, error)) (string, error) {
	nodes, err := html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
	if err != nil {
		// Unparseable content: leave it untouched rather than fail the item.
		return content, nil
	}

	changed := false
	for _, n := range nodes {
		c, err := walkNode(n, attrs, fn)
		if err != nil {
			return "", err
		}
		if c {
			changed = true
		}
	}
	if !changed {
		return content, nil
	}

	var b strings.Builder
	for _, n := range nodes {
		if err := html.Render(&b, n); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

// walkNode applies fn to the attrs-listed attributes on n and its descendants,
// replacing each value when fn returns ok. Returns true if any value changed, or
// the first error fn returns (which stops the walk).
func walkNode(n *html.Node, attrs map[string][]string, fn func(tag, attr, val string) (string, bool, error)) (bool, error) {
	changed := false
	if n.Type == html.ElementNode {
		if names, ok := attrs[n.Data]; ok {
			for _, name := range names {
				for i := range n.Attr {
					if n.Attr[i].Key != name {
						continue
					}
					nv, ok, err := fn(n.Data, name, n.Attr[i].Val)
					if err != nil {
						return false, err
					}
					if ok {
						n.Attr[i].Val = nv
						changed = true
					}
				}
			}
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		cc, err := walkNode(c, attrs, fn)
		if err != nil {
			return false, err
		}
		if cc {
			changed = true
		}
	}
	return changed, nil
}
```

- [ ] **Step 4: Run the mod tests to verify all pass**

Run: `cd backend && go test ./mod/`
Expected: PASS — the new tests AND the pre-existing `RewriteAttrs` tests (`TestRewriteAttrsRewritesImgVideoAnchor`, `TestRewriteAttrsCoversAnchorHref`, …) stay green, proving the refactor preserved behavior.

- [ ] **Step 5: Commit**

```bash
git add backend/mod/helper_assets.go backend/mod/helper_assets_test.go
git commit -m "refactor(mod): extract shared walkAssetAttrs; add audio asset attr

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 3: The `#selfhost` mod

**Files:**
- Create: `backend/mod/selfhost.go`
- Test: `backend/mod/selfhost_test.go`

- [ ] **Step 1: Write the failing tests**

Create `backend/mod/selfhost_test.go`:

```go
package mod

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// mediaServer serves fixed bytes and counts requests, so dedup is observable.
func mediaServer(t *testing.T, body string) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// cacheFileCount counts non-temp files left in the cache dir.
func cacheFileCount(t *testing.T, dir string) int {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	n := 0
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), ".selfhost-") {
			n++
		}
	}
	return n
}

func TestSelfhostDownloadsImgVideoAudioPoster(t *testing.T) {
	allowPrivateForTest(t) // httptest is on loopback
	srv, _ := mediaServer(t, "BYTES")
	dir := t.TempDir()

	item := &RawItem{Content: `<p><img src="` + srv.URL + `/a.jpg"></p>` +
		`<video src="` + srv.URL + `/b.mp4" poster="` + srv.URL + `/c.jpg"></video>` +
		`<audio src="` + srv.URL + `/d.mp3"></audio>`}
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, srv.URL) {
		t.Errorf("a remote URL survived: %s", item.Content)
	}
	if got := strings.Count(item.Content, `="#`); got != 4 {
		t.Errorf("expected 4 markers, got %d in %s", got, item.Content)
	}
	if got := cacheFileCount(t, dir); got != 4 {
		t.Errorf("expected 4 cached files, got %d", got)
	}
}

func TestSelfhostDedupsByURL(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)

	for _, guid := range []uint32{1, 2} {
		item := &RawItem{GUID: guid, Content: `<img src="` + srv.URL + `/same.jpg">`}
		if err := m.Process(ctx, "#selfhost", item); err != nil {
			t.Fatalf("Process: %v", err)
		}
	}
	if *hits != 1 {
		t.Errorf("same URL fetched %d times, want 1 (URL cache)", *hits)
	}
}

func TestSelfhostFailsOpen(t *testing.T) {
	allowPrivateForTest(t)
	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	t.Cleanup(notFound.Close)
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)

	cases := map[string]string{
		"404":            `<img src="` + notFound.URL + `/x.jpg">`,
		"non-http":       `<img src="ftp://example.com/x.jpg">`,
		"already-hosted": `<img src="assets/ab/cd.jpg">`,
	}
	for name, content := range cases {
		item := &RawItem{Content: content}
		if err := m.Process(ctx, "#selfhost", item); err != nil {
			t.Fatalf("%s: Process should fail open, got %v", name, err)
		}
		if item.Content != content {
			t.Errorf("%s: content changed, got %q want %q", name, item.Content, content)
		}
	}
	if got := cacheFileCount(t, dir); got != 0 {
		t.Errorf("no file should be written on failure, got %d", got)
	}
}

func TestSelfhostMaxBodyFailsOpen(t *testing.T) {
	allowPrivateForTest(t)
	srv, _ := mediaServer(t, "THIS-BODY-IS-LONGER-THAN-THE-CAP")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	content := `<img src="` + srv.URL + `/big.jpg">`
	item := &RawItem{Content: content}
	if err := m.Process(ctx, "#selfhost maxbody=4", item); err != nil {
		t.Fatalf("Process should fail open, got %v", err)
	}
	if item.Content != content {
		t.Errorf("oversize asset should leave the URL, got %q", item.Content)
	}
	if got := cacheFileCount(t, dir); got != 0 {
		t.Errorf("oversize asset must not leave a cache file, got %d", got)
	}
}

func TestSelfhostBlocksSSRF(t *testing.T) {
	// No allowPrivateForTest: the loopback test server must be refused by the
	// SSRF guard, and #selfhost must fail open (leave the URL).
	srv, _ := mediaServer(t, "BYTES")
	dir := t.TempDir()
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	content := `<img src="` + srv.URL + `/x.jpg">`
	item := &RawItem{Content: content}
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process should fail open under SSRF guard, got %v", err)
	}
	if item.Content != content {
		t.Errorf("SSRF-blocked URL should be left in place, got %q", item.Content)
	}
}

func TestSelfhostNoCacheDirIsNoop(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	content := `<img src="` + srv.URL + `/x.jpg">`
	item := &RawItem{Content: content}
	m := New()
	// No WithCacheDir on the context (mirrors srr preview).
	if err := m.Process(context.Background(), "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != content {
		t.Errorf("no-cache-dir should be a no-op, got %q", item.Content)
	}
	if *hits != 0 {
		t.Errorf("no-cache-dir must not fetch, got %d hits", *hits)
	}
}

func TestSelfhostRejectsBadParams(t *testing.T) {
	m := New()
	dir := t.TempDir()
	ctx := WithCacheDir(context.Background(), dir)
	for _, token := range []string{
		"#selfhost foo=bar",
		"#selfhost timeout=abc",
		"#selfhost maxbody=12xb",
		"#selfhost timeout",
	} {
		item := &RawItem{Content: `<img src="http://example.com/x.jpg">`}
		if err := m.Process(ctx, token, item); err == nil {
			t.Errorf("token %q: expected a configuration error", token)
		}
	}
}

func TestSelfhostLeavesAnchorHref(t *testing.T) {
	allowPrivateForTest(t)
	srv, hits := mediaServer(t, "BYTES")
	dir := t.TempDir()
	content := `<a href="` + srv.URL + `/doc.pdf">file</a>`
	item := &RawItem{Content: content}
	m := New()
	ctx := WithCacheDir(context.Background(), dir)
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != content || *hits != 0 {
		t.Errorf("anchor href is out of scope; content=%q hits=%d", item.Content, *hits)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./mod/ -run TestSelfhost`
Expected: FAIL — the `#selfhost` token is unregistered, so `Process` falls through to the shell path (`/bin/sh -c "#selfhost"`), which is a no-op comment; assertions on rewriting/markers fail.

- [ ] **Step 3: Write `selfhost.go`**

Create `backend/mod/selfhost.go`:

```go
package mod

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// #selfhost downloads an item's remote <img>/<video>/<audio> media into the
// fetch run's shared cache dir and rewrites each reference to a "#"-marker, so
// the end-of-pipeline upload step (main.Feed.fetch -> RewriteAttrs ->
// assetFetcher.UploadCacheRef) peeks, converts via SRR_ASSET_PROCESS, and
// content-hash uploads it to assets/. The mod itself stores/converts nothing.
//
// Place it AFTER #base (feed pipe ["#base", "#selfhost"]): it then downloads
// only sanitizer-approved media, and its markers (incl. <video poster>) never
// round-trip through #sanitize. Network-bound, so it honours the fetch context.
//
// Fail-open per asset: a bad URL, non-2xx, oversize, SSRF-blocked dial, or write
// error leaves the original remote URL in place (WARN). It is a no-op when the
// fetch context carries no cache dir (srr preview / the Validate sentinel).
//
// Parameters tune the per-asset fetch (defaults below): "timeout" (Go duration)
// and "maxbody" (byte size). A malformed/unknown parameter is a hard error.
//   #selfhost timeout=120s maxbody=128MiB

const (
	selfhostTimeout   = 120 * time.Second
	selfhostMaxBody   = 128 << 20
	selfhostUserAgent = "Mozilla/5.0 (compatible; SRR/1.0; +media-self-host)"
)

func init() {
	Register("selfhost", func() Processor {
		// One SSRF-guarded client per Module (per fetch worker via procPool):
		// media URLs come from attacker-controlled feed content, so dials to
		// private/loopback/link-local addresses are refused.
		client := &http.Client{Transport: SafeTransport()}
		return func(ctx context.Context, p Params, i *RawItem) error {
			timeout, err := p.Duration("timeout", selfhostTimeout)
			if err != nil {
				return err
			}
			maxBody, err := p.Bytes("maxbody", selfhostMaxBody)
			if err != nil {
				return err
			}
			if err := p.only("timeout", "maxbody"); err != nil {
				return err
			}

			cacheDir := cacheDirFromContext(ctx)
			if cacheDir == "" {
				// No run cache dir (preview / Validate): nothing to download into
				// and no uploader downstream. Leave content as-is.
				return nil
			}
			// Cheap guard: skip the HTML parse when there is no media element.
			if !strings.Contains(i.Content, "<img") &&
				!strings.Contains(i.Content, "<video") &&
				!strings.Contains(i.Content, "<audio") {
				return nil
			}

			content, err := walkAssetAttrs(i.Content, mediaAttrs, func(_, _, val string) (string, bool, error) {
				marker, ok := downloadToCache(ctx, client, cacheDir, val, timeout, maxBody)
				return marker, ok, nil // fail-open: ok=false leaves the URL; never errors
			})
			if err != nil {
				// An HTML render error from the walk: fail open, keep original.
				slog.Warn("selfhost: content rewrite failed; keeping original", "link", i.Link, "err", err)
				return nil
			}
			i.Content = content
			return nil
		}
	})
}

// downloadToCache fetches an absolute http(s) media URL into cacheDir under a
// URL-hashed filename and returns the "#<filename>" marker the upload step
// consumes. It returns ("", false) — leaving the original value — for any
// non-fatal condition (relative/non-http ref, fetch failure, non-2xx, oversize,
// write error), so one bad asset never fails the item. A file already present
// for the URL is reused (download dedup; upload dedup is UploadCacheRef's).
func downloadToCache(ctx context.Context, client *http.Client, cacheDir, rawURL string, timeout time.Duration, maxBody int64) (string, bool) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false // relative assets/ keys, #fragments, data: — not ours
	}

	sum := sha256.Sum256([]byte(rawURL))
	name := hex.EncodeToString(sum[:8]) + cleanExt(u.Path) // 8 bytes -> 16 hex
	full := filepath.Join(cacheDir, name)

	// URL-level download cache: a URL already fetched (this run or a prior one)
	// is reused as-is.
	if _, err := os.Stat(full); err == nil {
		return "#" + name, true
	}

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", selfhostUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("selfhost: download failed; keeping remote URL", "url", rawURL, "err", err)
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Warn("selfhost: non-2xx; keeping remote URL", "url", rawURL, "status", resp.StatusCode)
		return "", false
	}

	// LimitReader to maxBody+1 so an over-cap body is detected (n > maxBody) and
	// rejected rather than silently truncated and stored.
	if !streamToCacheFile(cacheDir, full, io.LimitReader(resp.Body, maxBody+1), maxBody) {
		return "", false
	}
	return "#" + name, true
}

// streamToCacheFile spools r to a temp file in cacheDir and atomically renames
// it into place. Returns false (removing the temp file) on an over-cap body
// (n > maxBody) or any IO error, so the caller leaves the original URL. Atomic
// rename means a cancelled/failed download never leaves a partial file a
// concurrent worker could pick up.
func streamToCacheFile(cacheDir, full string, r io.Reader, maxBody int64) bool {
	tmp, err := os.CreateTemp(cacheDir, ".selfhost-*")
	if err != nil {
		slog.Warn("selfhost: temp create failed", "err", err)
		return false
	}
	tmpName := tmp.Name()
	n, copyErr := io.Copy(tmp, r)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil || n > maxBody {
		os.Remove(tmpName)
		if n > maxBody {
			slog.Warn("selfhost: asset over maxbody; keeping remote URL", "max", maxBody)
		}
		return false
	}
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		slog.Warn("selfhost: rename failed", "err", err)
		return false
	}
	return true
}

// cleanExt returns the URL path's extension when it is a short, clean
// alphanumeric extension (2-6 chars incl. the dot), else "". A query-laden or
// extension-less URL yields ""; asset-peek/asset-process identify the real type
// by bytes regardless, so the cache extension is only a hint.
func cleanExt(p string) string {
	ext := path.Ext(p)
	if len(ext) < 2 || len(ext) > 6 {
		return ""
	}
	for _, r := range ext[1:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	return strings.ToLower(ext)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./mod/ -run TestSelfhost`
Expected: PASS (all `TestSelfhost*` cases).

- [ ] **Step 5: Commit**

```bash
git add backend/mod/selfhost.go backend/mod/selfhost_test.go
git commit -m "feat(mod): #selfhost downloads remote media into the run cache

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 4: Wire the cache dir onto the fetch context (`feed.go`)

`#selfhost` reads the cache dir from context; `Feed.Fetch` is where the run's `cacheDir` is in scope.

**Files:**
- Modify: `backend/feed.go` (in `Feed.Fetch`, around line 108-134)

- [ ] **Step 1: Add the wiring line**

In `backend/feed.go`, in `func (c *Feed) Fetch(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module)`, immediately after `c.newItems = c.newItems[:0]` and before `pipe := resolvePipe(...)`, insert:

```go
	// Expose the run's shared asset cache dir to pipeline mods (e.g. #selfhost)
	// via context, so a built-in can download media into it and emit upload
	// markers. Set before Validate so every downstream step (and the throwaway
	// Validate run) sees it; srr preview never sets it, so #selfhost no-ops there.
	ctx = mod.WithCacheDir(ctx, run.cacheDir)
```

- [ ] **Step 2: Verify it builds and existing tests pass**

Run: `cd backend && go build ./... && go test ./...`
Expected: PASS (no behavior change yet for existing feeds; the round-trip in Task 6 exercises the new path).

- [ ] **Step 3: Commit**

```bash
git add backend/feed.go
git commit -m "feat(backend): expose run cache dir to mods via fetch context

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 5: Allow `<audio>` in the backend sanitizer

`#selfhost` runs after `#sanitize`, so `<audio>` must survive the policy or there is nothing to find. Mirror the `<video>` allowance (no poster/visual attrs).

**Files:**
- Modify: `backend/mod/sanitize.go` (near the `<video>` block, ~lines 36-42)
- Test: `backend/mod/sanitize_test.go` (new)

- [ ] **Step 1: Write the failing tests**

Create `backend/mod/sanitize_test.go`:

```go
package mod

import (
	"context"
	"strings"
	"testing"
)

func TestSanitizeAllowsAudio(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<audio src="https://cdn.example/a.mp3" controls preload="none"></audio>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	for _, want := range []string{"<audio", `src="https://cdn.example/a.mp3"`, "controls", `preload="none"`} {
		if !strings.Contains(item.Content, want) {
			t.Errorf("missing %q in %q", want, item.Content)
		}
	}
}

func TestSanitizeStripsAudioBadAttrsAndSource(t *testing.T) {
	m := New()
	item := &RawItem{Content: `<audio src="https://cdn.example/a.mp3" onplay="x()" preload="evil">` +
		`<source src="https://cdn.example/a.ogg"></audio>`}
	if err := m.Process(context.Background(), "#sanitize", item); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	if strings.Contains(item.Content, "onplay") {
		t.Errorf("onplay survived: %q", item.Content)
	}
	if strings.Contains(item.Content, `preload="evil"`) {
		t.Errorf("bad preload value survived: %q", item.Content)
	}
	if strings.Contains(item.Content, "<source") {
		t.Errorf("<source> survived (not allowlisted): %q", item.Content)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./mod/ -run TestSanitize`
Expected: FAIL — `<audio>` is stripped today (`TestSanitizeAllowsAudio` finds none of its strings).

- [ ] **Step 3: Add the `<audio>` allowance**

In `backend/mod/sanitize.go`, directly after the `<video>` block (the line `policy.AllowElements("video")`), add:

```go
		// <audio> mirrors <video> minus the visual/poster attrs. bluemonday
		// URL-scheme-validates "src" like it does for video/img. controls and
		// preload are constrained to their valid token sets. #selfhost runs after
		// #sanitize, so <audio> must survive here for its media to be self-hosted;
		// the frontend (fmt.ts) forces controls so a control-less feed <audio>
		// still renders a player.
		policy.AllowAttrs("src").OnElements("audio")
		policy.AllowAttrs("preload").Matching(regexp.MustCompile(`(?i)^(none|metadata|auto)$`)).OnElements("audio")
		policy.AllowAttrs("controls").Matching(regexp.MustCompile(`(?i)^(|controls)$`)).OnElements("audio")
		policy.AllowElements("audio")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./mod/ -run TestSanitize`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/mod/sanitize.go backend/mod/sanitize_test.go
git commit -m "feat(mod): allow <audio> src/controls/preload in #sanitize

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 6: Main-package round-trip test

Prove the marker `#selfhost` produces is consumed by the real upload seam (`RewriteAttrs` + `assetFetcher.UploadCacheRef`) into an `assets/…` key — the exact two steps `feed.go:fetchURL` runs. `UploadCacheRef` is unexported in package `main`, so this lives in `feed_test.go`.

**Files:**
- Modify: `backend/feed_test.go`

- [ ] **Step 1: Write the test**

Append to `backend/feed_test.go` (reuses `tempStore`, `readKey`, `contentHashKey`, `newAssetFetcher` from `assets_test.go`, same package). Ensure the imports `context`, `crypto/sha256`, `net/http`, `net/http/httptest`, `strings`, `testing`, and `srrb/mod` are present in the file's import block (add any missing):

```go
func TestSelfhostMarkerRoundTripsToAssetsKey(t *testing.T) {
	// Allow the loopback test server through the mod's SSRF guard.
	prevSSRF := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prevSSRF })

	const body = "\xff\xd8\xff\xe0\x00\x10JFIF-some-jpeg-bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	be := tempStore(t)
	af := newAssetFetcher(be, 1<<20, "") // no SRR_ASSET_PROCESS: store source bytes
	cacheDir := t.TempDir()
	ctx := mod.WithCacheDir(context.Background(), cacheDir)

	// 1) #selfhost downloads the remote image and rewrites src to a "#"-marker.
	item := &mod.RawItem{Content: `<p><img src="` + srv.URL + `/x.jpg"></p>`}
	m := mod.New()
	if err := m.Process(ctx, "#selfhost", item); err != nil {
		t.Fatalf("selfhost: %v", err)
	}
	if !strings.Contains(item.Content, `src="#`) {
		t.Fatalf("expected an upload marker, got %q", item.Content)
	}

	// 2) The upload step (mirrors feed.go fetchURL): marker -> assets/ key.
	out, err := mod.RewriteAttrs(item.Content, func(local string) (string, bool, error) {
		key, err := af.UploadCacheRef(ctx, cacheDir, local)
		if err != nil {
			return "", false, err
		}
		return key, true, nil
	})
	if err != nil {
		t.Fatalf("upload step: %v", err)
	}

	sum := sha256.Sum256([]byte(body))
	wantKey := contentHashKey(".jpg", sum)
	if !strings.Contains(out, wantKey) {
		t.Fatalf("content %q missing assets key %q", out, wantKey)
	}
	if got := string(readKey(t, be, wantKey)); got != body {
		t.Errorf("stored bytes = %q, want %q", got, body)
	}
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd backend && go test . -run TestSelfhostMarkerRoundTripsToAssetsKey`
Expected: PASS. (If it fails to compile on a missing import, add it to `feed_test.go`'s import block and re-run.)

- [ ] **Step 3: Commit**

```bash
git add backend/feed_test.go
git commit -m "test(backend): round-trip #selfhost marker to an assets/ key

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 7: Frontend `<audio>` sanitizer branch (force controls + resolve src)

**Files:**
- Modify: `frontend/src/js/fmt.ts` (the `sanitizeHtml` tag switch, ~lines 132-168)
- Test: `frontend/src/js/fmt.test.ts`

- [ ] **Step 1: Write the failing tests**

In `frontend/src/js/fmt.test.ts`, inside the `describe("sanitizeHtml security edge cases", ...)` block (which defines the `attr(html, sel, name)` helper and runs against the `http://localhost:3000/` pack base), add:

```ts
   it("keeps <audio> and forces controls (a control-less feed <audio> is invisible)", () => {
      const out = sanitizeHtml('<audio src="assets/ab/cd.webm"></audio>')
      expect(out).toContain("<audio")
      expect(out).toContain("controls")
   })

   it("resolves a relative <audio src> against the pack base", () => {
      expect(attr('<audio src="assets/ab/cd.webm">', "audio", "src")).toBe(
         "http://localhost:3000/assets/ab/cd.webm",
      )
   })

   it("passes an external <audio src> through unproxied (audio is not an image)", () => {
      setImgProxy("https://p.example/?u=")
      expect(attr('<audio src="https://feed.example/a.mp3">', "audio", "src")).toBe(
         "https://feed.example/a.mp3",
      )
   })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/js/fmt.test.ts -t "audio"`
Expected: FAIL — no `AUDIO` branch: `controls` isn't forced and the relative `src` isn't resolved against the pack base.

- [ ] **Step 3: Add the `AUDIO` branch**

In `frontend/src/js/fmt.ts`, in the `sanitizeHtml` tag switch, add a branch after the `} else if (tag === "VIDEO") { … }` block:

```ts
      } else if (tag === "AUDIO") {
         // A feed <audio> often omits `controls`, which renders the element with
         // no player UI (invisible). Force it — like <img> gets forced lazy/async
         // above — so self-hosted audio is actually playable. src isn't an image:
         // a relative assets/ key resolves against the pack base, an external
         // http(s) src passes through (proxy:false — image proxies don't handle
         // audio), exactly like <video src>.
         node.setAttribute("controls", "")
         resolveMediaAttr(node, "src", proxyPrefix, false)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/js/fmt.test.ts`
Expected: PASS (the new audio cases and the whole existing `fmt.test.ts` suite).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/js/fmt.ts frontend/src/js/fmt.test.ts
git commit -m "feat(frontend): sanitize+resolve <audio>, force controls

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

### Task 8: Documentation + full verify

**Files:**
- Modify: `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `backend/README.md`

- [ ] **Step 1: Document the mod in `backend/CLAUDE.md`**

In the built-in module list (the `#sanitize`/`#minify`/`#readability`/`#filter` bullets in the "Module System (`mod/`)" section), add after the `#filter` bullet:

```markdown
- `#selfhost` — downloads remote `<img>`/`<video>`/`<audio>` media (src + `<video poster>`, not `<a href>`) into the run's shared cache dir and rewrites each to a `#`-marker, so the end-of-pipeline upload step peeks/converts (`SRR_ASSET_PROCESS`)/uploads it to `assets/`. Network-bound (SSRF-guarded `SafeTransport`, like `#readability`); reads the run cache dir from the fetch context (`mod.WithCacheDir`, set in `feed.go:Feed.Fetch`) and **no-ops when absent** (e.g. `srr preview`). Params: `timeout=` (default 120s), `maxbody=` (default 128MiB); bad/unknown param is a hard error. **Fail-open per asset**: a bad URL / non-2xx / oversize / SSRF-blocked dial / write error leaves the remote URL in place (WARN). Download dedup is URL→cache-file; upload dedup is `UploadCacheRef`'s content hash. **Place AFTER `#base`** (`["#base", "#selfhost"]`): it then downloads only sanitizer-approved media and its markers (incl. `<video poster>`) never round-trip through `#sanitize`. Limitations: with `webify` as `SRR_ASSET_PROCESS`, audio is self-hosted but not transcoded (webify is image/video only); `<source>` children stay stripped; cross-run URL cache may serve stale bytes (clear the cache dir).
```

In the "Asset self-hosting" subsection, update the marker-source sentence to note an internal mod is now a producer — change the phrase describing who drops markers to include: "an external ingest command **or the built-in `#selfhost` mod**".

- [ ] **Step 2: Note the sanitizer parity change in both CLAUDE.md files**

In `backend/CLAUDE.md`, in the `#sanitize` bullet, append: " Allows `<audio>` (`src`/`controls`/`preload`, mirroring `<video>`) so `#selfhost` can self-host audio."

In `frontend/CLAUDE.md`, in the `fmt.ts` row's `sanitizeHtml` description (the relative-URL resolution sentence listing `<img src>`/`<video src>`/`<video poster>`/`<a href>`), add `<audio src>` to that list and append: " `<audio>` is force-given `controls` (a control-less feed `<audio>` renders no player)."

- [ ] **Step 3: Update `backend/README.md` if it lists built-in mods**

Run: `cd backend && grep -n "#readability\|#filter\|Built-in mod" README.md`
If the built-in mods are listed there, add a `#selfhost` entry mirroring the one-line summary from Step 1 (download remote media → marker → existing upload step; fail-open; place after `#base`). If they are not listed, skip this step.

- [ ] **Step 4: Run the generate-check (no format atoms changed, but confirm)**

Run: `cd backend && make -C .. generate-check 2>/dev/null || go run . gen-ts --check`
Expected: PASS — no contract atoms changed (the `<audio>` allowance and `#selfhost` aren't part of `format.gen.ts`).

- [ ] **Step 5: Full verify (backend + frontend + contract)**

Run: `make verify`
Expected: PASS — `verify-be` (vet + gofmt + build + test + generate-check), `verify-fe` (lint + format + test + build), and the e2e contract layer all green.

- [ ] **Step 6: Commit**

```bash
git add backend/CLAUDE.md frontend/CLAUDE.md backend/README.md
git commit -m "docs: document #selfhost mod and <audio> sanitizer parity

Claude-Session: https://claude.ai/code/session_015Ag51qHFjYrg3rTUZCUYxb"
```

---

## Notes for the implementer

- **TDD throughout:** each task writes the test first, watches it fail, then implements. Don't skip the "verify it fails" step — it proves the test exercises the new behavior.
- **Fail-open is load-bearing:** `#selfhost` must never return a non-nil error for a network/asset problem. The only errors it returns are config errors (bad params), surfaced by `Module.Validate` before the item loop. A returned error would make `feed.go` drop the item.
- **Run `sanitizer-parity-reviewer`** (the project agent) after Tasks 5 + 7 to confirm the backend bluemonday allowlist and the frontend `fmt.ts` filter agree on `<audio>`.
- **Manual smoke (optional):** point a dev store at a feed with inline images, set `SRR_ASSET_PROCESS=webify`, add `#selfhost` after `#base` (`srr feed upd <id> -p "#base" -p "#selfhost"`), fetch, and confirm `assets/…` keys appear and the reader renders them. Use the `srr` / `srr-backend` skills for the deploy/fetch plumbing.
```
