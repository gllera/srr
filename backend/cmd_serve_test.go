package main

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
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

// GET / serves the embedded admin bundle (the committed placeholder in a bare
// checkout, the real Parcel index.html after `make build-admin`). Assert only
// what both share — HTML, non-empty, naming the admin console — so the test is
// independent of whether the frontend was built.
func TestServeUIIndex(t *testing.T) {
	h := newMux()
	rec := doReq(t, h, "GET", "/", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, want text/html", ct)
	}
	if body := rec.Body.String(); !strings.Contains(body, "<!doctype html") && !strings.Contains(body, "<!DOCTYPE html") {
		if len(body) > 200 {
			body = body[:200]
		}
		t.Fatalf("index body is not HTML; got:\n%s", body)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "srr") {
		t.Fatal("index body does not name the SRR admin console")
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

// A GUI served through a Host-rewriting proxy (cloudflared tunnel with a
// httpHostHeader override) presents a loopback Host but the browser's real,
// non-loopback Origin on every mutation. The browser-set Sec-Fetch-Site header
// distinguishes the GUI's own requests (same-origin) from a CSRF attacker's
// (cross-site), so only the former may bypass the loopback-Origin requirement.
func TestServeHostGuardProxiedOrigin(t *testing.T) {
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
		req := httptest.NewRequest("GET", "/", nil)
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
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "evil.example.com:8088"
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("rebound Host with same-origin fetch metadata = %d, want 403", rec.Code)
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
	check("GET / (bundle)", doReq(t, h, "GET", "/", ""))
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

// The Parcel bundle is content-hashed, so webUICacheHeaders splits its
// Cache-Control like store.cacheControlForKey: a hashed asset name is immutable
// (cached a year, no revalidation), while index.html (and any unhashed root
// file) is no-cache + a startup content ETag that answers 304. Tested against a
// synthetic FS so it is independent of whether the real bundle was built.
func TestServeWebUICacheValidators(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>SRR admin</title>")},
		"frontend.abcdef01.js": {Data: []byte("console.log(1)")},
	}
	h := webUICacheHeaders(fsys, http.FileServerFS(fsys))

	// A hashed asset name → immutable.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/frontend.abcdef01.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET hashed asset = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Errorf("hashed Cache-Control = %q, want immutable", cc)
	}
	if tag := rec.Header().Get("ETag"); tag != "" {
		t.Errorf("hashed asset carried an ETag %q; immutable names need none", tag)
	}

	// index.html (served for /) → no-cache + a content ETag.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", rec.Code)
	}
	tag := rec.Header().Get("ETag")
	if tag == "" {
		t.Fatal("no ETag on index.html")
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("index Cache-Control = %q, want no-cache", cc)
	}

	// A matching If-None-Match answers 304 with no body.
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("If-None-Match", tag)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Errorf("conditional GET = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("304 carried a %d-byte body", rec.Body.Len())
	}

	// A stale validator still serves the fresh bytes.
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("If-None-Match", `"stale"`)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Errorf("stale validator: code=%d len=%d, want 200 with a body", rec.Code, rec.Body.Len())
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
