package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// doReq sends body as JSON, labelled the way the admin console's api() labels
// every body it sends.
func doReq(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	contentType := ""
	if body != "" {
		contentType = "application/json"
	}
	return doRawReq(t, h, method, target, contentType, body)
}

// doRawReq is doReq with the Content-Type spelled out ("" sends none): the
// non-JSON bodies (an OPML import) and the media-type checks themselves.
func doRawReq(t *testing.T, h http.Handler, method, target, contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, r)
	req.Host = "localhost"
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
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

// serve is API-only: no admin bundle at "/", no HTTP MCP transport. The admin
// page ships in the frontend bundle and MCP is stdio (`srr mcp`) only.
func TestServeAPIOnly(t *testing.T) {
	setupTestDB(t)
	h := newMux()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/"},
		{http.MethodGet, "/index.html"},
		{http.MethodGet, "/mcp"},
		{http.MethodPost, "/mcp"},
		{http.MethodDelete, "/mcp"},
	} {
		rec := doReq(t, h, tc.method, tc.path, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
	}
	if rec := doReq(t, h, http.MethodGet, "/api/overview", ""); rec.Code != http.StatusOK {
		t.Errorf("GET /api/overview = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}

// A malformed JSON body is rejected with 400 by every mutating handler that
// decodes one (the shared decodeJSON seam): feeds save, recipe put, syndicate
// put. decodeJSON runs before any DB scope, so a bad body never touches state.
func TestServeMalformedJSONBodyRejected(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/feeds"},
		{"PUT", "/api/recipes/x"},
		{"PUT", "/api/syndicate/x"},
	} {
		rec := doReq(t, newMux(), tc.method, tc.path, `{bad`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s %s with malformed body = %d, want 400 (%s)", tc.method, tc.path, rec.Code, rec.Body)
		}
	}
}

// A JSON body must say it is JSON. A plain HTML form submits only
// text/plain, application/x-www-form-urlencoded or multipart/form-data, and a
// text/plain form can carry a body that parses as JSON — so a route that
// decoded whatever arrived could be driven by a form. Every JSON-body route
// answers anything but application/json with 415, before touching the store
// or running a probe.
func TestServeJSONBodyRequiresJSONContentType(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()
	marker := filepath.Join(t.TempDir(), "ran")
	probe := probeBody(t, map[string]any{"url": "https://x.example/f", "ingest": "touch " + marker})
	routes := []struct{ method, path, body string }{
		{"POST", "/api/feeds", `{"title":"T","url":"https://x.example/feed"}`},
		{"PUT", "/api/feeds/0", `{"title":"T","url":"https://x.example/feed"}`},
		{"POST", "/api/feeds/apply", `[{"title":"T","url":"https://x.example/feed"}]`},
		{"PUT", "/api/recipes/x", `{"pipe":["#sanitize"]}`},
		{"PUT", "/api/syndicate/x", `{"format":"rss","ext":true}`},
		{"PUT", "/api/dedup", `{"days":14}`},
		{"POST", "/api/preview", probe},
		{"POST", "/api/resolve", probe},
	}
	for _, rt := range routes {
		for _, ct := range []string{
			"",
			"text/plain",
			"text/plain;charset=UTF-8",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
			"application/jsonx",
			"application/json, text/plain",
		} {
			rec := doRawReq(t, newMux(), rt.method, rt.path, ct, rt.body)
			if rec.Code != http.StatusUnsupportedMediaType {
				t.Errorf("%s %s with Content-Type %q = %d, want 415 (%s)", rt.method, rt.path, ct, rec.Code, rec.Body)
			}
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a probe ran its ingest command on a non-JSON body")
	}
	var ov overviewView
	if err := json.Unmarshal(doReq(t, newMux(), "GET", "/api/overview", "").Body.Bytes(), &ov); err != nil {
		t.Fatal(err)
	}
	if _, ok := ov.Recipes["x"]; len(ov.Feeds) != 0 || ok || len(ov.Out) != 0 || ov.DedupDays != defaultDedupDays {
		t.Errorf("a non-JSON body changed the store: %+v", ov)
	}
}

// The check is on the media type alone: parameters ride along and the type
// is case-insensitive.
func TestServeJSONContentTypeParametersAndCase(t *testing.T) {
	setupTestDB(t)
	for i, ct := range []string{
		"application/json",
		"application/json; charset=utf-8",
		"application/json;charset=UTF-8",
		"Application/JSON",
	} {
		rec := doRawReq(t, newMux(), "PUT", "/api/dedup", ct, fmt.Sprintf(`{"days":%d}`, 10+i))
		if rec.Code != http.StatusOK {
			t.Errorf("Content-Type %q = %d, want 200 (%s)", ct, rec.Code, rec.Body)
		}
	}
}

// A JSON body is one JSON value and nothing after it. A streaming decoder
// stops at the end of the first value, so a route reading through one would
// act on that value and drop whatever followed — a second value, or garbage —
// with a 200, where `srr feed apply` rejects the same input. Every JSON-body
// route answers 400 instead, before touching the store or running a probe.
func TestServeJSONBodyRejectsTrailingData(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()
	if rec := doReq(t, newMux(), "POST", "/api/feeds", `{"title":"Keep","url":"https://keep.example/feed"}`); rec.Code != http.StatusOK {
		t.Fatalf("seed = %d (%s)", rec.Code, rec.Body)
	}
	marker := filepath.Join(t.TempDir(), "ran")
	probe := probeBody(t, map[string]any{"url": "https://x.example/f", "ingest": "touch " + marker})
	routes := []struct{ method, path, body string }{
		{"POST", "/api/feeds", `{"title":"T","url":"https://x.example/feed"}`},
		{"PUT", "/api/feeds/0", `{"title":"T","url":"https://keep.example/feed"}`},
		{"POST", "/api/feeds/apply", `{"title":"T","url":"https://x.example/feed"}`},
		{"POST", "/api/feeds/apply", `[{"title":"T","url":"https://x.example/feed"}]`},
		{"PUT", "/api/recipes/x", `{"pipe":["#sanitize"]}`},
		{"PUT", "/api/syndicate/x", `{"format":"rss","ext":true}`},
		{"PUT", "/api/dedup", `{"days":14}`},
		{"POST", "/api/preview", probe},
		{"POST", "/api/resolve", probe},
	}
	before := doReq(t, newMux(), "GET", "/api/overview", "").Body.String()
	for _, rt := range routes {
		// "}" and "]" are the stray closers a check for "is another value
		// coming?" would read as the end of an enclosing one.
		for _, tail := range []string{"\n" + rt.body, " trailing-garbage", "}", "]"} {
			rec := doReq(t, newMux(), rt.method, rt.path, rt.body+tail)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "decode request body") {
				t.Errorf("%s %s with %q after the value = %d (%s), want 400 from the decode", rt.method, rt.path, tail, rec.Code, rec.Body)
			}
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a probe ran its ingest command on a body with trailing data")
	}
	if after := doReq(t, newMux(), "GET", "/api/overview", "").Body.String(); after != before {
		t.Errorf("a body with trailing data changed the store:\nbefore %s\nafter  %s", before, after)
	}
}

// Whitespace after the value is not data: a body ending in a newline, as a
// file sent with `curl --data-binary @feeds.json` usually does, is accepted
// on every JSON-body route.
func TestServeJSONBodyAllowsTrailingWhitespace(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()
	allowLoopback(t)
	probe := probeBody(t, map[string]any{"url": rssServer(t)})
	for _, rt := range []struct{ method, path, body string }{
		{"POST", "/api/feeds", `{"title":"T","url":"https://x.example/feed"}`},
		{"PUT", "/api/feeds/0", `{"title":"U","url":"https://x.example/feed"}`},
		{"POST", "/api/feeds/apply", `{"title":"A","url":"https://a.example/feed"}`},
		{"POST", "/api/feeds/apply", `[{"title":"B","url":"https://b.example/feed"}]`},
		{"PUT", "/api/recipes/x", `{"pipe":["#sanitize"]}`},
		{"PUT", "/api/syndicate/x", `{"format":"rss","ext":true}`},
		{"PUT", "/api/dedup", `{"days":14}`},
		{"POST", "/api/preview", probe},
		{"POST", "/api/resolve", probe},
	} {
		for _, tail := range []string{"\n", " \t\r\n"} {
			if rec := doReq(t, newMux(), rt.method, rt.path, rt.body+tail); rec.Code != http.StatusOK {
				t.Errorf("%s %s with %q after the value = %d, want 200 (%s)", rt.method, rt.path, tail, rec.Code, rec.Body)
			}
		}
	}
}

func TestServeHostGuardRejectsNonLoopback(t *testing.T) {
	h := newMux()
	req := httptest.NewRequest("GET", "/api/overview", nil)
	req.Host = "evil.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-loopback Host = %d, want 403", rec.Code)
	}
}

func TestServeHostGuardRejectsCrossOrigin(t *testing.T) {
	h := newMux()
	req := httptest.NewRequest("GET", "/api/overview", nil)
	req.Host = "localhost"
	req.Header.Set("Origin", "http://evil.example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin = %d, want 403", rec.Code)
	}
}

// A GUI served through a Host-rewriting reverse proxy (one that rewrites Host
// to the loopback address, docs/SELF-HOSTING.md) presents a loopback Host but
// the browser's real, non-loopback Origin on every mutation. The browser-set
// Sec-Fetch-Site header
// distinguishes the GUI's own requests (same-origin) from a CSRF attacker's
// (cross-site), so only the former may bypass the loopback-Origin requirement.
func TestServeHostGuardProxiedOrigin(t *testing.T) {
	setupTestDB(t)
	for _, tc := range []struct {
		fetchSite string
		want      int
	}{
		{"same-origin", http.StatusOK},
		{"cross-site", http.StatusForbidden},
		{"same-site", http.StatusForbidden},
		{"", http.StatusForbidden},
	} {
		h := newMux()
		req := httptest.NewRequest("GET", "/api/overview", nil)
		req.Host = "localhost:8088"
		req.Header.Set("Origin", "https://srr.example.com")
		if tc.fetchSite != "" {
			req.Header.Set("Sec-Fetch-Site", tc.fetchSite)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("Sec-Fetch-Site %q = %d, want %d", tc.fetchSite, rec.Code, tc.want)
		}
	}
}

// Sec-Fetch-Site must not weaken the Host check: a DNS-rebinding page IS
// same-origin from the browser's perspective, but its Host is the attacker's
// hostname — the guard rejects it regardless of fetch metadata.
func TestServeHostGuardRebindingDespiteSameOrigin(t *testing.T) {
	h := newMux()
	req := httptest.NewRequest("GET", "/api/overview", nil)
	req.Host = "evil.example.com:8088"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("rebound Host with same-origin fetch metadata = %d, want 403", rec.Code)
	}
}

// Markup can make a browser request a same-origin URL with no script at all:
// an <img>/<video>/<audio> src, a stylesheet, a frame, a form post. Through the
// Host-rewriting proxy such a request presents a loopback Host and, being a
// GET or same-origin, nothing the Origin check refuses — the same shape as the
// admin page's own calls. Fetch metadata tells them apart: the admin page and
// the reader reach serve only through fetch(), whose destination is "empty",
// and the one navigation serve answers is the admin page's Export download.
// A request carrying no Sec-Fetch-Dest at all (curl, MCP, an older browser)
// keeps passing.
func TestServeHostGuardFetchDestination(t *testing.T) {
	setupTestDB(t)
	for _, tc := range []struct {
		method, target, dest string
		want                 int
	}{
		{"GET", "/api/overview", "image", http.StatusForbidden},
		{"GET", "/api/overview", "script", http.StatusForbidden},
		{"GET", "/api/overview", "style", http.StatusForbidden},
		{"GET", "/api/overview", "video", http.StatusForbidden},
		{"GET", "/api/overview", "iframe", http.StatusForbidden},
		{"GET", "/api/overview", "document", http.StatusForbidden},
		{"GET", "/sync/phone", "image", http.StatusForbidden},
		{"POST", "/api/feeds", "document", http.StatusForbidden}, // a form post
		{"POST", "/api/feeds", "iframe", http.StatusForbidden},   // a form posted into a frame
		{"GET", "/api/export", "image", http.StatusForbidden},
		{"GET", "/api/export", "iframe", http.StatusForbidden},
		{"POST", "/api/export", "document", http.StatusForbidden},
		{"GET", "/api/export/x", "document", http.StatusForbidden},

		{"GET", "/api/overview", "empty", http.StatusOK},
		{"GET", "/api/overview", "", http.StatusOK},
		{"GET", "/api/export", "document", http.StatusOK},
		{"GET", "/api/export?format=json", "document", http.StatusOK},
		{"HEAD", "/api/export", "document", http.StatusOK},
	} {
		req := httptest.NewRequest(tc.method, tc.target, nil)
		req.Host = "localhost:8088"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		if tc.method != http.MethodGet && tc.method != http.MethodHead {
			req.Header.Set("Origin", "https://srr.example.com")
		}
		if tc.dest != "" {
			req.Header.Set("Sec-Fetch-Dest", tc.dest)
		}
		rec := httptest.NewRecorder()
		newMux().ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s %s with Sec-Fetch-Dest %q = %d, want %d (%s)", tc.method, tc.target, tc.dest, rec.Code, tc.want, rec.Body)
		}
	}
}

// The guard runs before any handler: an image pointed at a probe route must
// not get as far as the ingest command it names.
func TestServeHostGuardImageCannotRunProbe(t *testing.T) {
	setupTestDB(t)
	marker := filepath.Join(t.TempDir(), "ran")
	q := url.Values{"url": {"https://x.example/f"}, "ingest": {"touch " + marker}}
	for _, path := range []string{"/api/preview", "/api/resolve"} {
		req := httptest.NewRequest(http.MethodGet, path+"?"+q.Encode(), nil)
		req.Host = "localhost:8088"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Sec-Fetch-Dest", "image")
		rec := httptest.NewRecorder()
		newMux().ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("image GET %s = %d, want 403 (%s)", path, rec.Code, rec.Body)
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatalf("image GET %s ran its ingest command", path)
		}
	}
}

// Destination "empty" is not fetch() alone: markup reaches it too — an
// <a ping> (a POST, on a click) and a <link rel=prefetch> — in mode "no-cors".
// fetch() and the reader's keepalive PUT run in mode "cors" ("same-origin" if a
// caller ever asks for it), and the Export download is a "navigate". The
// headers are what Chrome sends for each.
func TestServeHostGuardFetchMode(t *testing.T) {
	setupTestDB(t)
	for _, tc := range []struct {
		name, method, target, dest, mode, contentType, body string
		want                                                int
	}{
		{"a ping", "POST", "/api/fetch?id=1", "empty", "no-cors", "text/ping", "PING", http.StatusForbidden},
		{"a prefetch", "GET", "/api/overview", "empty", "no-cors", "", "", http.StatusForbidden},
		{"a prefetch of the sync blob", "GET", "/sync/phone", "empty", "no-cors", "", "", http.StatusForbidden},

		{"fetch()", "GET", "/api/overview", "empty", "cors", "", "", http.StatusOK},
		{"fetch() same-origin mode", "GET", "/api/overview", "empty", "same-origin", "", "", http.StatusOK},
		{"the Export download", "GET", "/api/export", "document", "navigate", "", "", http.StatusOK},
		{"fetch metadata without a mode", "GET", "/api/overview", "empty", "", "", "", http.StatusOK},
	} {
		var body io.Reader
		if tc.body != "" {
			body = strings.NewReader(tc.body)
		}
		req := httptest.NewRequest(tc.method, tc.target, body)
		req.Host = "localhost:8088"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Sec-Fetch-Dest", tc.dest)
		if tc.mode != "" {
			req.Header.Set("Sec-Fetch-Mode", tc.mode)
		}
		if tc.method != http.MethodGet && tc.method != http.MethodHead {
			req.Header.Set("Origin", "https://srr.example.com")
		}
		if tc.contentType != "" {
			req.Header.Set("Content-Type", tc.contentType)
		}
		rec := httptest.NewRecorder()
		newMux().ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: %s %s (dest %q, mode %q) = %d, want %d (%s)", tc.name, tc.method, tc.target, tc.dest, tc.mode, rec.Code, tc.want, rec.Body)
		}
	}
}

// secHeaders (SEC3) stamps the static security headers on EVERY response —
// wrapped outside hostGuard so even a 403 carries them.
func TestServeSecHeaders(t *testing.T) {
	setupTestDB(t)
	h := newMux()
	want := map[string]string{
		"Content-Security-Policy": webUICSP,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
		"X-Frame-Options":         "DENY",
	}
	check := func(name string, rec *httptest.ResponseRecorder) {
		for k, v := range want {
			if got := rec.Header().Get(k); got != v {
				t.Errorf("%s: %s = %q, want %q", name, k, got, v)
			}
		}
	}
	check("GET / (404 — serve is API-only)", doReq(t, h, "GET", "/", ""))
	check("GET /api/overview (200)", doReq(t, h, "GET", "/api/overview", ""))
	check("DELETE missing feed (4xx)", doReq(t, h, "DELETE", "/api/feeds/99999", ""))

	// hostGuard 403 — secHeaders is the outer wrapper, so a rejected request
	// still carries the headers.
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "evil.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("precondition: non-loopback Host = %d, want 403", rec.Code)
	}
	check("hostGuard 403", rec)
}

// The same-origin design has NO CORS layer — a negative test so nobody
// re-introduces Access-Control-* (Candidate A's tax) without noticing.
func TestServeNoCORSHeaders(t *testing.T) {
	setupTestDB(t)
	h := newMux()
	for _, target := range []string{"/", "/api/overview"} {
		rec := doReq(t, h, "GET", target, "")
		for _, k := range []string{
			"Access-Control-Allow-Origin",
			"Access-Control-Allow-Credentials",
			"Access-Control-Allow-Methods",
			"Access-Control-Allow-Headers",
		} {
			if got := rec.Header().Get(k); got != "" {
				t.Errorf("GET %s emitted %s: %q, want none", target, k, got)
			}
		}
	}
}

func TestLoopbackHost(t *testing.T) {
	for _, tc := range []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:8088", true},
		{"127.0.0.1", true},
		{"127.0.0.1:8088", true},
		{"::1", true},
		{"[::1]", true},
		{"[::1]:8088", true},
		{"evil.example.com", false},
		{"evil.example.com:8088", false},
		{"", false},
		{"192.168.1.4:8080", false},
	} {
		if got := loopbackHost(tc.host); got != tc.want {
			t.Errorf("loopbackHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

// The PUT handler shares setOutFeed, so external entries round-trip through
// the API with the same validation matrix as the CLI.
func TestServeSyndicatePutExternal(t *testing.T) {
	setupTestDB(t)

	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss","ext":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT external = %d (%s), want 200", rec.Code, rec.Body)
	}
	db2, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("NewDB: %v", err)
	}
	defer db2.Close(ctx)
	if len(db2.core.Out) != 1 || !db2.core.Out[0].External {
		t.Errorf("Out = %+v, want one external entry", db2.core.Out)
	}

	rec = doReq(t, newMux(), "PUT", "/api/syndicate/y", `{"format":"rss","ext":true,"tags":["a"]}`)
	if rec.Code == http.StatusOK {
		t.Error("external entry with selectors was accepted; setOutFeed matrix not enforced")
	}

	rec = doReq(t, newMux(), "GET", "/api/overview", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ext":true`) {
		t.Errorf("overview = %d %q, want 200 carrying \"ext\":true", rec.Code, rec.Body)
	}
}

// 404 must be decided by the wrapped fs.ErrNotExist sentinel, not by the words
// in the message — and a validation rejection whose text happens to contain
// "not found" must stay a 400.
func TestServeWriteErrStatusIsStructural(t *testing.T) {
	rec := httptest.NewRecorder()
	writeErr(rec, fmt.Errorf("feed id 7 not found: %w", fs.ErrNotExist))
	if rec.Code != http.StatusNotFound {
		t.Errorf("sentinel-wrapped error = %d, want 404", rec.Code)
	}

	rec2 := httptest.NewRecorder()
	writeErr(rec2, fmt.Errorf("recipe %q not found in the pipeline", "x"))
	if rec2.Code != http.StatusBadRequest {
		t.Errorf("plain validation error mentioning 'not found' = %d, want 400", rec2.Code)
	}

	rec3 := httptest.NewRecorder()
	writeErr(rec3, fmt.Errorf("busy: %w", os.ErrExist))
	if rec3.Code != http.StatusConflict {
		t.Errorf("lock contention = %d, want 409", rec3.Code)
	}
}
