package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// syncDirForTest points the endpoint at a per-test directory and restores the
// process-wide default afterwards, so no test can write a profile into the
// operator's real ~/.config/srr/sync.
func syncDirForTest(t *testing.T) string {
	t.Helper()
	prev := syncBlobDir
	dir := t.TempDir()
	syncBlobDir = dir
	t.Cleanup(func() { syncBlobDir = prev })
	return dir
}

// The whole contract sync.ts asks of an endpoint, in the order a reader meets
// it: GET before anything is stored is a 404 (the "seed me" signal, NOT an
// error), a PUT stores the body, and the next GET returns those bytes verbatim.
func TestServeSyncRoundTrip(t *testing.T) {
	dir := syncDirForTest(t)
	h := newMux()

	if rec := doReq(t, h, "GET", "/sync/phone", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("first GET = %d, want 404 (nothing stored yet)", rec.Code)
	}

	blob := `{"v":2,"ts":42,"seen":{"feed:1":7},"st":{"feed:1":42},"saved":[3],"sd":{"3":42}}`
	if rec := doReq(t, h, "PUT", "/sync/phone", blob); rec.Code != http.StatusNoContent {
		t.Fatalf("PUT = %d (%s), want 204", rec.Code, rec.Body)
	}

	rec := doReq(t, h, "GET", "/sync/phone", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("second GET = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != blob {
		t.Fatalf("GET body = %q, want the stored bytes verbatim %q", got, blob)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("content-type = %q, want application/json", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("cache-control = %q, want no-store (the blob is mutable device state)", cc)
	}
	if _, err := os.Stat(filepath.Join(dir, "phone.json")); err != nil {
		t.Errorf("blob file: %v", err)
	}

	// Last writer wins, whole-blob — the documented posture (sync.ts pulls
	// before it pushes and re-publishes whatever an overwrite cost it).
	if rec := doReq(t, h, "PUT", "/sync/phone", `{"v":2,"ts":99}`); rec.Code != http.StatusNoContent {
		t.Fatalf("overwrite PUT = %d, want 204", rec.Code)
	}
	if got := doReq(t, h, "GET", "/sync/phone", "").Body.String(); got != `{"v":2,"ts":99}` {
		t.Fatalf("after overwrite = %q, want the newer blob", got)
	}

	// Names are separate slots — two devices/people share one server.
	if rec := doReq(t, h, "GET", "/sync/laptop", ""); rec.Code != http.StatusNotFound {
		t.Errorf("unrelated name = %d, want 404", rec.Code)
	}
}

func TestServeSyncRejects(t *testing.T) {
	syncDirForTest(t)
	h := newMux()
	big := `{"pad":"` + strings.Repeat("x", maxSyncBody) + `"}`
	for _, tc := range []struct {
		name, method, target, body string
		want                       int
	}{
		{"non-JSON body", "PUT", "/sync/phone", "not json at all", http.StatusBadRequest},
		{"JSON but not an object", "PUT", "/sync/phone", `[1,2,3]`, http.StatusBadRequest},
		{"JSON scalar", "PUT", "/sync/phone", `42`, http.StatusBadRequest},
		{"empty body", "PUT", "/sync/phone", "", http.StatusBadRequest},
		{"oversize body", "PUT", "/sync/phone", big, http.StatusRequestEntityTooLarge},
		// The filename guard. A leading dot is what the regex is really for:
		// it hides the file and, unescaped, is the only shape that could name
		// something outside the directory.
		{"dotfile name", "PUT", "/sync/.hidden", `{}`, http.StatusBadRequest},
		{"name with a bad char", "PUT", "/sync/a%20b", `{}`, http.StatusBadRequest},
		{"over-long name", "GET", "/sync/" + strings.Repeat("n", 65), "", http.StatusBadRequest},
		// A nested path is not a {name} segment at all, so it never reaches the
		// handler — the admin console's GET / wildcard answers instead.
		{"nested path", "PUT", "/sync/a/b", `{}`, http.StatusMethodNotAllowed},
		{"unsupported method", "DELETE", "/sync/phone", "", http.StatusMethodNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := doReq(t, h, tc.method, tc.target, tc.body)
			if rec.Code != tc.want {
				t.Fatalf("%s %s = %d (%s), want %d", tc.method, tc.target, rec.Code, strings.TrimSpace(rec.Body.String()), tc.want)
			}
		})
	}
	// The two traversal names never even reach the handler: ServeMux cleans
	// dot segments out of the path and answers a redirect first. The regex is
	// the second line of that defence, asserted directly since no request can
	// carry them to it.
	for _, bad := range []string{".", "..", "", "a/b", ".hidden", "a b", strings.Repeat("n", 65)} {
		if syncNameRe.MatchString(bad) {
			t.Errorf("syncNameRe accepts %q", bad)
		}
	}
	for _, ok := range []string{"phone", "a", "my-device_2.json0", strings.Repeat("n", 64)} {
		if !syncNameRe.MatchString(ok) {
			t.Errorf("syncNameRe rejects %q", ok)
		}
	}

	// Nothing above may have created a file.
	ents, err := os.ReadDir(syncBlobDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(ents) != 0 {
		t.Fatalf("rejected requests left %d file(s) behind: %v", len(ents), ents)
	}
}

// The endpoint sits INSIDE hostGuard like /api/* and /mcp, and this route must
// not carve an exception out of it: a non-loopback Host is refused on the read
// side as well as the write side, a cross-site browser request is refused, and
// the ONE shape that passes is the proxied deployment the guard was built for —
// a Host-rewriting tunnel plus the browser's own same-origin fetch metadata.
func TestServeSyncHostGuard(t *testing.T) {
	syncDirForTest(t)
	h := newMux()
	if rec := doReq(t, h, "PUT", "/sync/phone", `{"v":2}`); rec.Code != http.StatusNoContent {
		t.Fatalf("seed PUT = %d, want 204", rec.Code)
	}
	send := func(method, host, origin, fetchSite string) int {
		req := httptest.NewRequest(method, "/sync/phone", strings.NewReader(`{"v":2}`))
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if fetchSite != "" {
			req.Header.Set("Sec-Fetch-Site", fetchSite)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, m := range []string{"GET", "PUT"} {
		if got := send(m, "evil.example", "", ""); got != http.StatusForbidden {
			t.Errorf("%s with a non-loopback Host = %d, want 403", m, got)
		}
		if got := send(m, "localhost:8088", "https://reader.example", "cross-site"); got != http.StatusForbidden {
			t.Errorf("cross-site %s = %d, want 403", m, got)
		}
		if got := send(m, "localhost:8088", "https://reader.example", "same-origin"); got == http.StatusForbidden {
			t.Errorf("same-origin proxied %s = 403; the supported deployment must pass", m)
		}
	}
}

// With no --sync-dir the routes still exist but report themselves off, so an
// operator gets a legible answer rather than the admin console's index.html.
func TestServeSyncDisabled(t *testing.T) {
	prev := syncBlobDir
	syncBlobDir = ""
	t.Cleanup(func() { syncBlobDir = prev })
	h := newMux()
	for _, tc := range []struct{ method, body string }{{"GET", ""}, {"PUT", `{"v":2}`}} {
		rec := doReq(t, h, tc.method, "/sync/phone", tc.body)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s while disabled = %d, want 404", tc.method, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "disabled") {
			t.Errorf("%s while disabled: body %q does not say so", tc.method, rec.Body.String())
		}
	}
}
