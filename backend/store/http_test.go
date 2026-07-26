package store

import (
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
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
		case http.MethodHead:
			b, ok := f.objs[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(b)))
			w.WriteHeader(http.StatusOK)
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
	rc, err := b.Get(ctx, "sub/dir/file.txt")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
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
	rc, _ := b.Get(ctx, "file.txt")
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

	if err := b.Put(ctx, "data/3.gz", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	f.mu.Lock()
	ct := f.contentTypes["/base/data/3.gz"]
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

func TestHTTPStat(t *testing.T) {
	b := openHTTPStore(t, newHTTPFixture(t))

	if err := b.Put(ctx, "obj.bin", strings.NewReader("12345"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n, err := b.Stat(ctx, "obj.bin"); err != nil || n != 5 {
		t.Errorf("Stat = (%d, %v), want (5, nil)", n, err)
	}
	// A missing key is an fs.ErrNotExist-wrapped error, never a silent
	// zero — a nil error from Stat has to PROVE presence. Pinned for all
	// four backends at once in TestBackendMissingKeyConformance; kept here
	// so a single-backend edit trips its own test too.
	if _, err := b.Stat(ctx, "missing.bin"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Stat(missing) err = %v, want errors.Is(err, fs.ErrNotExist)", err)
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

	rc, err := b.Get(ctx, "file.txt")
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

// A HEAD response with no Content-Length reports size 0 — accounting is
// best-effort on plain HTTP stores (resp.ContentLength -1 clamps to 0).
func TestHTTPStatNoContentLength(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK) // no Content-Length, empty body
	}))
	t.Cleanup(srv.Close)
	b, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	if n, err := b.Stat(ctx, "obj"); err != nil || n != 0 {
		t.Errorf("Stat(no Content-Length) = (%d, %v), want (0, nil)", n, err)
	}
}

// A non-2xx GET (500) is a wrapped error carrying the status.
func TestHTTPGetServerErrorWrapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	b, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { b.Close() })
	rc, err := b.Get(ctx, "obj")
	if rc != nil {
		rc.Close()
	}
	if err == nil {
		t.Fatal("Get on a 500 should return an error")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error should carry the status, got %v", err)
	}
}

// HTTPConfig.Insecure skips TLS certificate verification: a write to a
// self-signed TLS server fails by default and succeeds with Insecure=true.
func TestHTTPInsecureSkipsTLSVerify(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(srv.Close)
	orig := httpCfg
	t.Cleanup(func() { httpCfg = orig })

	// Default (verify on): the self-signed cert is rejected.
	httpCfg = HTTPConfig{}
	strict, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { strict.Close() })
	if err := strict.Put(ctx, "obj", strings.NewReader("x"), true); err == nil {
		t.Error("Put to a self-signed TLS server should fail verification by default")
	}

	// Insecure: verification skipped, the write succeeds.
	httpCfg = HTTPConfig{Insecure: true}
	insecure, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { insecure.Close() })
	if err := insecure.Put(ctx, "obj", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put with Insecure=true should succeed against a self-signed TLS server: %v", err)
	}
}

// The backend must never borrow http.DefaultTransport: its Close used to flush
// that pool's idle connections out from under every other user in the process.
// It carries its own, memoized per config so repeated Opens (one per serve API
// request) share ONE connection pool — and forked only by the axis that actually
// shapes a transport, TLS verification.
func TestHTTPTransportIsolatedPerConfig(t *testing.T) {
	f := newHTTPFixture(t)
	orig := httpCfg
	t.Cleanup(func() { httpCfg = orig })

	httpCfg = HTTPConfig{}
	strict, ok := openHTTPStore(t, f).(*HTTP)
	if !ok {
		t.Fatal("Open did not return the HTTP backend")
	}
	if strict.client.Transport == http.DefaultTransport {
		t.Error("the store borrowed http.DefaultTransport; Close would flush the whole process's keep-alives")
	}
	again, _ := openHTTPStore(t, f).(*HTTP)
	if strict.client.Transport != again.client.Transport {
		t.Error("two Opens under one config built two pools; the memo should hand out one")
	}

	httpCfg = HTTPConfig{Insecure: true}
	insecure, _ := openHTTPStore(t, f).(*HTTP)
	if insecure.client.Transport == strict.client.Transport {
		t.Error("Insecure shares the verifying transport; TLS policy must fork the pool")
	}

	// Credentials are per-REQUEST, so they must NOT fork a pool (and must not
	// end up in the memo key).
	httpCfg = HTTPConfig{Token: "tok", Headers: map[string]string{"X-Api-Key": "k"}}
	tokened, _ := openHTTPStore(t, f).(*HTTP)
	if tokened.client.Transport != strict.client.Transport {
		t.Error("a bearer token forked the connection pool; only TLS policy may")
	}
}

// Close is a handle release, not a pool flush: the transport is shared with
// every other handle on this store, so a closed handle must leave a concurrent
// (or subsequent) request's keep-alive intact.
func TestHTTPCloseKeepsIdleConnections(t *testing.T) {
	var mu sync.Mutex
	conns := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			conns++
			mu.Unlock()
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)

	orig := httpCfg
	httpCfg = HTTPConfig{}
	t.Cleanup(func() { httpCfg = orig })

	first, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.Put(ctx, "a", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(ctx, srv.URL)
	if err != nil {
		t.Fatalf("Open(second): %v", err)
	}
	t.Cleanup(func() { second.Close() })
	if err := second.Put(ctx, "b", strings.NewReader("x"), true); err != nil {
		t.Fatalf("Put(second): %v", err)
	}

	mu.Lock()
	got := conns
	mu.Unlock()
	if got != 1 {
		t.Errorf("server saw %d connections, want 1 — Close flushed the pool the next handle shares", got)
	}
}

// HEAD (Stat) may follow redirects like GET — both are bodiless reads; the
// guard still refuses redirected writes (TestHTTPWriteRedirectFailsLoudly).
func TestHTTPStatFollowsRedirect(t *testing.T) {
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

	if n, err := b.Stat(ctx, "file.txt"); err != nil || n != 4 {
		t.Errorf("Stat through redirect = (%d, %v), want (4, nil)", n, err)
	}
}
