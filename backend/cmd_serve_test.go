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
	if !strings.Contains(rec.Body.String(), "<title>SRRB</title>") {
		body := rec.Body.String()
		if len(body) > 200 {
			body = body[:200]
		}
		t.Fatalf("index body missing title; got:\n%s", body)
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

func TestServeStaticAssets(t *testing.T) {
	h := newMux()
	for _, tc := range []struct{ path, needle string }{
		{"/app.js", "drawFeeds"},
		{"/app.css", "--signal"},
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
