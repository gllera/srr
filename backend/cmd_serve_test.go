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
