package store

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// httpFixture is an in-memory HTTP object server: GET reads, PUT writes
// (honouring If-None-Match: * as exclusive create), DELETE removes. It records
// the Content-Type of each PUT and the Authorization header of every request.
type httpFixture struct {
	srv          *httptest.Server
	mu           sync.Mutex
	objs         map[string][]byte
	contentTypes map[string]string
	lastAuth     string
	lastHeaders  http.Header
}

func newHTTPFixture(t *testing.T) *httpFixture {
	t.Helper()
	f := &httpFixture{objs: map[string][]byte{}, contentTypes: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lastAuth = r.Header.Get("Authorization")
		f.lastHeaders = r.Header.Clone()
		key := r.URL.Path
		switch r.Method {
		case http.MethodGet:
			b, ok := f.objs[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(b)
		case http.MethodPut:
			if r.Header.Get("If-None-Match") == "*" {
				if _, exists := f.objs[key]; exists {
					w.WriteHeader(http.StatusPreconditionFailed)
					return
				}
			}
			b, err := io.ReadAll(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			f.objs[key] = b
			f.contentTypes[key] = r.Header.Get("Content-Type")
			w.WriteHeader(http.StatusCreated)
		case http.MethodDelete:
			if _, ok := f.objs[key]; !ok {
				http.NotFound(w, r)
				return
			}
			delete(f.objs, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *httpFixture) object(key string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objs[key]
	return b, ok
}

// openHTTPStore opens the backend under the /base prefix so key→URL joining is
// exercised against a non-root store path.
func openHTTPStore(t *testing.T, f *httpFixture) Backend {
	t.Helper()
	b, err := Open(ctx, f.srv.URL+"/base")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	return b
}

func TestHTTPPutGetRoundTrip(t *testing.T) {
	f := newHTTPFixture(t)
	b := openHTTPStore(t, f)

	if err := b.Put(ctx, "sub/dir/file.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, ok := f.object("/base/sub/dir/file.txt"); !ok {
		t.Fatal("PUT did not land under the store base path")
	}
	rc, err := b.Get(ctx, "sub/dir/file.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
}

func TestHTTPGetMissingIgnored(t *testing.T) {
	b := openHTTPStore(t, newHTTPFixture(t))

	rc, err := b.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignoreMissing=true) = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestHTTPGetMissingErrors(t *testing.T) {
	b := openHTTPStore(t, newHTTPFixture(t))

	rc, err := b.Get(ctx, "missing.txt", false)
	if rc != nil {
		rc.Close()
	}
	if err == nil {
		t.Error("Get(missing, ignoreMissing=false) should return error")
	}
}

func TestHTTPPutExclusiveCreate(t *testing.T) {
	b := openHTTPStore(t, newHTTPFixture(t))

	if err := b.Put(ctx, "file.txt", strings.NewReader("first"), false); err != nil {
		t.Fatalf("Put(first): %v", err)
	}
	if err := b.Put(ctx, "file.txt", strings.NewReader("second"), false); err == nil {
		t.Error("Put(ignoreExisting=false) on existing key should fail")
	}
	if err := b.Put(ctx, "file.txt", strings.NewReader("third"), true); err != nil {
		t.Errorf("Put(ignoreExisting=true) overwrite: %v", err)
	}
	rc, _ := b.Get(ctx, "file.txt", false)
	if got := readAllClose(t, rc); got != "third" {
		t.Errorf("content = %q, want %q", got, "third")
	}
}

func TestHTTPAtomicPutContentType(t *testing.T) {
	f := newHTTPFixture(t)
	b := openHTTPStore(t, f)

	meta := ObjectMeta{ContentType: "application/yaml"}
	if err := b.AtomicPut(ctx, "srr.yaml", strings.NewReader("store: x"), meta); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	f.mu.Lock()
	ct := f.contentTypes["/base/srr.yaml"]
	f.mu.Unlock()
	if ct != "application/yaml" {
		t.Errorf("Content-Type = %q, want application/yaml", ct)
	}
	// AtomicPut overwrites (mirrors S3).
	if err := b.AtomicPut(ctx, "srr.yaml", strings.NewReader("store: y"), meta); err != nil {
		t.Errorf("AtomicPut overwrite: %v", err)
	}
}

// A pack write with no explicit ObjectMeta type declares application/gzip via
// contentTypeForKey (mirrors S3); it must carry no Content-Encoding — the
// reader gunzips manually.
func TestHTTPPutPackContentType(t *testing.T) {
	f := newHTTPFixture(t)
	b := openHTTPStore(t, f)

	if err := b.Put(ctx, "data/L3.gz", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.mu.Lock()
	ct := f.contentTypes["/base/data/L3.gz"]
	enc := f.lastHeaders.Get("Content-Encoding")
	f.mu.Unlock()
	if ct != "application/gzip" {
		t.Errorf("Content-Type = %q, want application/gzip", ct)
	}
	if enc != "" {
		t.Errorf("Content-Encoding = %q, want none", enc)
	}
}

func TestHTTPRm(t *testing.T) {
	f := newHTTPFixture(t)
	b := openHTTPStore(t, f)

	if err := b.Put(ctx, "file.txt", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := b.Rm(ctx, "file.txt"); err != nil {
		t.Fatalf("Rm: %v", err)
	}
	if _, ok := f.object("/base/file.txt"); ok {
		t.Error("object still present after Rm")
	}
	// Rm is contractually silent on missing keys.
	if err := b.Rm(ctx, "file.txt"); err != nil {
		t.Errorf("Rm(missing) = %v, want nil", err)
	}
}

// newRedirectFront fronts the fixture with a server that 302s every request to
// the same path on the real fixture — the nginx/https-upgrade shape.
func newRedirectFront(t *testing.T, f *httpFixture) *httptest.Server {
	t.Helper()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, f.srv.URL+strings.TrimPrefix(r.URL.Path, "/front"), http.StatusFound)
	}))
	t.Cleanup(front.Close)
	return front
}

// net/http silently replays a 301/302/303-redirected PUT/DELETE as a bodiless
// GET and reports the redirected GET's status — a write that never happened
// would read as success. Writes and deletes must fail loudly instead.
func TestHTTPWriteRedirectFailsLoudly(t *testing.T) {
	f := newHTTPFixture(t)
	// The trap needs an existing object: the downgraded GET then answers 200
	// and an unguarded Put would report success for a write that never ran.
	f.mu.Lock()
	f.objs["/base/file.txt"] = []byte("old")
	f.mu.Unlock()
	front := newRedirectFront(t, f)
	b, err := Open(ctx, front.URL+"/front/base")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })

	if err := b.Put(ctx, "file.txt", strings.NewReader("new"), true); err == nil {
		t.Error("Put through a 302 should fail, not silently no-op")
	}
	if err := b.AtomicPut(ctx, "file.txt", strings.NewReader("new"), ObjectMeta{}); err == nil {
		t.Error("AtomicPut through a 302 should fail, not silently no-op")
	}
	if got, _ := f.object("/base/file.txt"); string(got) != "old" {
		t.Errorf("object = %q, want %q untouched", got, "old")
	}
	if err := b.Rm(ctx, "file.txt"); err == nil {
		t.Error("Rm through a 302 should fail, not silently no-op")
	}
	if _, ok := f.object("/base/file.txt"); !ok {
		t.Error("object must survive the refused redirected delete")
	}
}

// Reads may follow redirects: a GET keeps its method and body-less semantics.
func TestHTTPGetFollowsRedirect(t *testing.T) {
	f := newHTTPFixture(t)
	f.mu.Lock()
	f.objs["/base/file.txt"] = []byte("data")
	f.mu.Unlock()
	front := newRedirectFront(t, f)
	b, err := Open(ctx, front.URL+"/front/base")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })

	rc, err := b.Get(ctx, "file.txt", false)
	if err != nil {
		t.Fatalf("Get through redirect: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
}

func TestHTTPBearerToken(t *testing.T) {
	f := newHTTPFixture(t)
	orig := httpCfg
	httpCfg = HTTPConfig{Token: "sekrit"}
	t.Cleanup(func() { httpCfg = orig })
	b := openHTTPStore(t, f)

	if err := b.Put(ctx, "file.txt", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.mu.Lock()
	auth := f.lastAuth
	f.mu.Unlock()
	if auth != "Bearer sekrit" {
		t.Errorf("Authorization = %q, want Bearer sekrit", auth)
	}
}

// Config headers ride every request; an explicit custom Authorization header
// wins over the bearer token.
func TestHTTPCustomHeaders(t *testing.T) {
	f := newHTTPFixture(t)
	orig := httpCfg
	httpCfg = HTTPConfig{Token: "tok", Headers: map[string]string{
		"X-Api-Key":     "k1",
		"Authorization": "Custom z",
	}}
	t.Cleanup(func() { httpCfg = orig })
	b := openHTTPStore(t, f)

	if err := b.Put(ctx, "file.txt", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.mu.Lock()
	hdr := f.lastHeaders
	f.mu.Unlock()
	if got := hdr.Get("X-Api-Key"); got != "k1" {
		t.Errorf("X-Api-Key = %q, want k1", got)
	}
	if got := hdr.Get("Authorization"); got != "Custom z" {
		t.Errorf("Authorization = %q, want the custom header to win over the token", got)
	}
}

func TestHTTPBasicAuthFromURL(t *testing.T) {
	f := newHTTPFixture(t)
	u, err := url.Parse(f.srv.URL + "/base")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	u.User = url.UserPassword("alice", "pw")
	b, err := Open(ctx, u.String())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })

	if err := b.Put(ctx, "file.txt", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.mu.Lock()
	auth := f.lastAuth
	f.mu.Unlock()
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:pw"))
	if auth != want {
		t.Errorf("Authorization = %q, want %q", auth, want)
	}
}
