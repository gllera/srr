package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"srr/store"
)

// makeTarGz builds a gzip-compressed tar of name→content, the way
// `tar czf srrf.tar.gz -C dist/srrf .` produces the release asset.
func makeTarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		body := files[name]
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatalf("tar header %q: %v", name, err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("tar write %q: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func TestMimeForKey(t *testing.T) {
	cases := []struct{ key, want string }{
		{"index.html", "text/html; charset=utf-8"},
		{"frontend.5730a221.css", "text/css; charset=utf-8"},
		{"frontend.778222e7.js", "text/javascript; charset=utf-8"},
		{"icon.aea4e164.svg", "image/svg+xml"},
		{"manifest.webmanifest", "application/manifest+json"},
		{"sitemap.txt", "text/plain; charset=utf-8"},
		{"icon-192.936dab90.png", "image/png"},
		{"apple-touch-icon.bcdd2574.png", "image/png"},
		{"mystery.xyzzy", "application/octet-stream"},
	}
	for _, c := range cases {
		if got := mimeForKey(c.key); got != c.want {
			t.Errorf("mimeForKey(%q) = %q, want %q", c.key, got, c.want)
		}
	}
}

func TestExtractTarGz(t *testing.T) {
	// Entries carry the leading "./" that `tar -C dir .` writes; it is stripped.
	data := makeTarGz(t, map[string]string{
		"./index.html":           "<html>",
		"./frontend.5730a221.js": "JS",
	})
	files, err := extractTarGz(data)
	if err != nil {
		t.Fatalf("extractTarGz: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2: %v", len(files), keysOfBytes(files))
	}
	if string(files["index.html"]) != "<html>" {
		t.Errorf("index.html = %q, want %q", files["index.html"], "<html>")
	}
	if string(files["frontend.5730a221.js"]) != "JS" {
		t.Errorf("frontend.5730a221.js = %q, want %q", files["frontend.5730a221.js"], "JS")
	}
}

func TestExtractTarGzRejectsUnsafeNames(t *testing.T) {
	for _, bad := range []string{"../evil.js", "/abs.js", "sub/dir.js", "a/../b.js"} {
		data := makeTarGz(t, map[string]string{bad: "x"})
		if _, err := extractTarGz(data); err == nil {
			t.Errorf("extractTarGz(%q) = nil error, want rejection", bad)
		}
	}
}

func TestExtractTarGzEmptyErrors(t *testing.T) {
	if _, err := extractTarGz(makeTarGz(t, map[string]string{})); err == nil {
		t.Error("extractTarGz(no files) should error")
	}
}

func keysOfBytes(m map[string][]byte) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// ghServer stands in for the GitHub REST API: it serves the release JSON for
// repo "test/repo" (both /releases/latest and /releases/tags/<tag>) and the
// srrf.tar.gz download, and points githubAPIBase at itself for the test.
func ghServer(t *testing.T, tag string, files map[string]string) {
	t.Helper()
	tarball := makeTarGz(t, files)
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	dlURL := srv.URL + "/dl/" + frontendAsset
	relJSON := fmt.Sprintf(
		`{"tag_name":%q,"assets":[{"name":"srr-linux-amd64","browser_download_url":%q},{"name":%q,"browser_download_url":%q}]}`,
		tag, srv.URL+"/dl/srr-linux-amd64", frontendAsset, dlURL)
	rel := func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, relJSON) }
	mux.HandleFunc("/repos/test/repo/releases/latest", rel)
	mux.HandleFunc("/repos/test/repo/releases/tags/"+tag, rel)
	mux.HandleFunc("/dl/"+frontendAsset, func(w http.ResponseWriter, _ *http.Request) { w.Write(tarball) })

	old := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = old })
}

func putKey(t *testing.T, be store.Backend, key, content string) {
	t.Helper()
	if err := be.Put(context.Background(), key, strings.NewReader(content), true); err != nil {
		t.Fatalf("seed %q: %v", key, err)
	}
}

func exists(t *testing.T, be store.Backend, key string) bool {
	t.Helper()
	rc, err := getOptional(context.Background(), be, key)
	if err != nil {
		t.Fatalf("get %q: %v", key, err)
	}
	if rc == nil {
		return false
	}
	rc.Close()
	return true
}

func TestFrontendUpdate(t *testing.T) {
	be := tempStore(t)
	ghServer(t, "v1.0.0", map[string]string{
		"./index.html":            "<html>",
		"./frontend.aaaaaaaa.js":  "JS",
		"./frontend.bbbbbbbb.css": "CSS",
	})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate: %v", err)
	}
	if got := string(readKey(t, be, "index.html")); got != "<html>" {
		t.Errorf("index.html = %q, want %q", got, "<html>")
	}
	if got := string(readKey(t, be, "frontend.aaaaaaaa.js")); got != "JS" {
		t.Errorf("frontend.aaaaaaaa.js = %q", got)
	}
	want := "frontend.aaaaaaaa.js\nfrontend.bbbbbbbb.css\nindex.html\n"
	if got := string(readKey(t, be, sitemapKey)); got != want {
		t.Errorf("sitemap = %q, want %q", got, want)
	}
}

func TestFrontendUpdateCleansOrphans(t *testing.T) {
	be := tempStore(t)
	putKey(t, be, "old.11111111.js", "OLD")
	putKey(t, be, "index.html", "OLDHTML")
	putKey(t, be, sitemapKey, "index.html\nold.11111111.js\n")

	ghServer(t, "v2", map[string]string{"./index.html": "NEW", "./new.22222222.js": "NEW"})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate: %v", err)
	}
	if exists(t, be, "old.11111111.js") {
		t.Error("orphan old.11111111.js should have been deleted")
	}
	if got := string(readKey(t, be, "index.html")); got != "NEW" {
		t.Errorf("index.html = %q, want overwrite NEW", got)
	}
	if !exists(t, be, "new.22222222.js") {
		t.Error("new file missing")
	}
	if got := string(readKey(t, be, sitemapKey)); got != "index.html\nnew.22222222.js\n" {
		t.Errorf("sitemap = %q", got)
	}
}

func TestFrontendUpdateTagUsesTagEndpoint(t *testing.T) {
	// Only the tags endpoint is registered; /releases/latest 404s. A successful
	// run proves --tag resolved through /releases/tags/<tag>.
	be := tempStore(t)
	tarball := makeTarGz(t, map[string]string{"./index.html": "TAGGED"})
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	dlURL := srv.URL + "/dl/" + frontendAsset
	mux.HandleFunc("/repos/test/repo/releases/tags/v3.1.4", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"tag_name":"v3.1.4","assets":[{"name":%q,"browser_download_url":%q}]}`, frontendAsset, dlURL)
	})
	mux.HandleFunc("/dl/"+frontendAsset, func(w http.ResponseWriter, _ *http.Request) { w.Write(tarball) })
	old := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = old })

	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", "v3.1.4"); err != nil {
		t.Fatalf("frontendUpdate(tag): %v", err)
	}
	if got := string(readKey(t, be, "index.html")); got != "TAGGED" {
		t.Errorf("index.html = %q, want TAGGED", got)
	}
}

func TestFrontendUpdateNoDanglingAcrossCrash(t *testing.T) {
	// Mimic a crashed prior run: the pending superset manifest tracks a
	// partially-uploaded file from an abandoned version, and that file is present.
	be := tempStore(t)
	putKey(t, be, "stale.99999999.js", "PARTIAL")
	putKey(t, be, "index.html", "OLD")
	putKey(t, be, sitemapKey, "index.html\nstale.99999999.js\n")

	ghServer(t, "v9", map[string]string{"./index.html": "NEW", "./fresh.88888888.js": "NEW"})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate: %v", err)
	}
	if exists(t, be, "stale.99999999.js") {
		t.Error("dangling file from a crashed run must be cleaned up")
	}
	if !exists(t, be, "fresh.88888888.js") {
		t.Error("new file missing")
	}
	if got := string(readKey(t, be, sitemapKey)); got != "fresh.88888888.js\nindex.html\n" {
		t.Errorf("sitemap = %q", got)
	}
}

func TestFrontendUpdateUploadFailureAborts(t *testing.T) {
	inner := tempStore(t)
	putKey(t, inner, "old.11111111.js", "OLD")
	putKey(t, inner, "index.html", "OLD")
	putKey(t, inner, sitemapKey, "index.html\nold.11111111.js\n")
	be := &faultBackend{Backend: inner, put: failKey("new.22222222.js")}

	ghServer(t, "v2", map[string]string{"./index.html": "NEW", "./new.22222222.js": "NEW"})
	err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", "")
	if err == nil {
		t.Fatal("expected upload failure to abort with an error")
	}
	// Cleanup must NOT have run: the old reader's files are intact.
	if !exists(t, inner, "old.11111111.js") {
		t.Error("orphan deleted despite upload failure")
	}
	// The pending superset manifest was written BEFORE the failing upload, so the
	// partially-uploaded version is fully tracked for the next run to reconcile.
	want := "index.html\nnew.22222222.js\nold.11111111.js\n"
	if got := string(readKey(t, inner, sitemapKey)); got != want {
		t.Errorf("pending sitemap = %q, want superset %q", got, want)
	}
}

func TestFrontendUpdateFailedDeleteStaysTracked(t *testing.T) {
	inner := tempStore(t)
	putKey(t, inner, "stubborn.11111111.js", "OLD")
	putKey(t, inner, "index.html", "OLD")
	putKey(t, inner, sitemapKey, "index.html\nstubborn.11111111.js\n")
	be := &faultBackend{Backend: inner, rm: failKey("stubborn.11111111.js")}

	ghServer(t, "v2", map[string]string{"./index.html": "NEW"})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate should succeed despite a failed delete: %v", err)
	}
	if !exists(t, inner, "stubborn.11111111.js") {
		t.Error("file whose delete failed should still be present")
	}
	// It must stay tracked so the next run retries it — never dropped (dangling).
	want := "index.html\nstubborn.11111111.js\n"
	if got := string(readKey(t, inner, sitemapKey)); got != want {
		t.Errorf("final sitemap = %q, want %q (failed delete stays tracked)", got, want)
	}
}

// TestFrontendUpdateListFindsUntrackedOrphans is what the store LIST buys here:
// sitemap.txt is a record of past INTENT, and a record can be absent (a first
// install that crashed, files that predate this command) while the files it
// should have named are very much present. Asking the store instead finds them.
//
// The second half is the safety line: only CONTENT-HASHED names — machine-minted
// per build, so unambiguously this command's output — are ever candidates. A
// pack, a root, an operator's own file at the store root are untouchable, and a
// stable-named shell file stays the sitemap's business because a listing cannot
// tell it from an operator's.
func TestFrontendUpdateListFindsUntrackedOrphans(t *testing.T) {
	be := tempStore(t)
	putKey(t, be, "orphan.11111111.js", "OLD") // hashed, and in NO sitemap
	putKey(t, be, "index.html", "OLDHTML")
	untouchable := []string{"db.gz", "config.gz", "idx/0.gz", "assets/ab/0123456789abcdef.jpg", "notes.txt"}
	for _, k := range untouchable {
		putKey(t, be, k, "keep me")
	}

	ghServer(t, "v2", map[string]string{"./index.html": "NEW", "./new.22222222.js": "NEW"})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate: %v", err)
	}
	if exists(t, be, "orphan.11111111.js") {
		t.Error("a hashed shell asset no sitemap tracked must be found by the listing and reclaimed")
	}
	for _, k := range untouchable {
		if !exists(t, be, k) {
			t.Errorf("%s was deleted; only content-hashed shell assets may ever be", k)
		}
	}
	if got := string(readKey(t, be, sitemapKey)); got != "index.html\nnew.22222222.js\n" {
		t.Errorf("sitemap = %q", got)
	}
}

// A store that cannot list keeps exactly the sitemap reconcile it always had —
// the fallback is silent, not an error.
func TestFrontendUpdateWithoutListUsesSitemap(t *testing.T) {
	inner := tempStore(t)
	putKey(t, inner, "old.11111111.js", "OLD")
	putKey(t, inner, "untracked.33333333.js", "ORPHAN") // unfindable without List
	putKey(t, inner, sitemapKey, "old.11111111.js\n")
	be := noListBackend{inner}

	ghServer(t, "v2", map[string]string{"./index.html": "NEW"})
	if err := frontendUpdate(context.Background(), be, http.DefaultClient, "test/repo", ""); err != nil {
		t.Fatalf("frontendUpdate: %v", err)
	}
	if exists(t, inner, "old.11111111.js") {
		t.Error("a sitemap-tracked orphan must still be reclaimed")
	}
	if !exists(t, inner, "untracked.33333333.js") {
		t.Error("an untracked file cannot be discovered without a listing; it must be left alone")
	}
}

// TestUploadOrder covers the two-entry-page bundle (index.html + admin.html):
// every root-level *.html entry page must upload after every non-HTML file
// (so it never lands ahead of the hashed bundle it references), and
// index.html — the reader's own entry, which callers additionally rely on
// finding at the end — must be the very last key of all.
func TestUploadOrder(t *testing.T) {
	in := []string{
		"admin.html",
		"admin.aaaaaaaa.js",
		"admin.bbbbbbbb.css",
		"frontend.cccccccc.js",
		"frontend.dddddddd.css",
		"index.html",
		"manifest.webmanifest",
	}
	out := uploadOrder(in)

	if got, want := len(out), len(in); got != want {
		t.Fatalf("uploadOrder dropped/added keys: got %d, want %d (%v)", got, want, out)
	}
	pos := make(map[string]int, len(out))
	for i, k := range out {
		pos[k] = i
	}
	if pos["index.html"] != len(out)-1 {
		t.Errorf("index.html at position %d, want last (%d): %v", pos["index.html"], len(out)-1, out)
	}
	for _, html := range []string{"admin.html", "index.html"} {
		for _, k := range in {
			if strings.HasSuffix(k, ".html") {
				continue
			}
			if pos[html] < pos[k] {
				t.Errorf("%s (pos %d) uploads before non-HTML file %s (pos %d): %v", html, pos[html], k, pos[k], out)
			}
		}
	}
}
