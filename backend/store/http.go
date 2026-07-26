package store

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

var httpCfg HTTPConfig

// HTTPConfig configures the HTTP backend. Basic auth rides the store URL's
// userinfo (https://user:pass@host/path); Token adds a bearer Authorization
// header instead. Headers are extra request headers sent on every operation
// (e.g. Cloudflare Access service-token headers) — an explicit Authorization
// entry wins over Token; values may be credentials, so the whole map is
// secret-tagged (masked by `srr config`). Set entries via YAML or the
// SRR_HTTP_HEADERS env var (comma-separated "Name: value" entries — see
// parseEnvMap; replaces the YAML map whole). Insecure skips TLS certificate
// verification (self-signed LAN endpoints).
type HTTPConfig struct {
	Token    string            `yaml:"token" secret:"true"`
	Headers  map[string]string `yaml:"headers" secret:"true"`
	Insecure bool              `yaml:"insecure"`
}

func init() {
	Register("http", newHTTP)
	Register("https", newHTTP)
	// One shared config section for both schemes, deliberately: Token/Insecure
	// apply identically regardless of transport security, so there is no
	// "https:" YAML section and no SRR_HTTPS_* env names.
	RegisterConfig("http", &httpCfg)
}

// HTTP is a plain HTTP object store — a WebDAV-style or S3-compatible endpoint
// that maps methods to object operations: GET reads a key, PUT writes it,
// DELETE removes it. Object metadata (Content-Type/-Encoding, Cache-Control)
// is sent as PUT request headers like S3 stamps it; servers that don't store
// metadata serve their own response headers instead, as with local/SFTP.
type HTTP struct {
	base   *url.URL
	client *http.Client
}

// httpTransports memoizes the backend's OWN transports, so an HTTP store keeps
// one connection pool across every store.Open (one per serve API request, one
// per fetch cycle) instead of borrowing the process-wide http.DefaultTransport.
// Borrowing was wrong in both directions: Close() flushed DefaultTransport's
// idle connections out from under every other user in the process (anything on
// http.DefaultClient — `srr inspect --url`'s http.Get, an SDK's default client),
// and this store's pool was never ours to shape.
//
// The key is the only config axis that shapes a transport: TLS verification.
// Token and Headers are per-REQUEST (newRequest stamps them), so they cannot
// fork a pool — which also keeps a credential out of a map key, and is why the
// key is a bool rather than the whole (map-carrying, uncomparable) HTTPConfig.
var (
	httpTransportsMu sync.Mutex
	httpTransports   = map[bool]*http.Transport{}
)

func httpTransportFor(insecure bool) *http.Transport {
	httpTransportsMu.Lock()
	defer httpTransportsMu.Unlock()
	if t, ok := httpTransports[insecure]; ok {
		return t
	}
	// Clone the stdlib defaults (proxy resolution, dial and TLS timeouts,
	// HTTP/2, idle-conn reaping) rather than restate them — then own the copy.
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	t := base.Clone()
	if insecure {
		// Reached only when the operator set http.insecure (or SRR_HTTP_INSECURE),
		// which is documented on HTTPConfig as exactly this: skip certificate
		// verification, for a self-signed LAN endpoint. An opt-in switch whose
		// entire purpose is the thing gosec is warning about.
		//nolint:gosec // G402: opt-in http.insecure, documented on HTTPConfig
		t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	httpTransports[insecure] = t
	return t
}

func newHTTP(_ context.Context, u *url.URL) (Backend, error) {
	base := *u
	base.Path = strings.TrimRight(base.Path, "/")

	// No client-level timeout: pack/asset uploads may legitimately run long and
	// every operation already carries the caller's context (run cancellation).
	client := &http.Client{
		Transport: httpTransportFor(httpCfg.Insecure),
		// net/http silently replays a 301/302/303-redirected PUT/DELETE as a
		// bodiless GET and reports the redirected GET's status — a write or
		// delete that never happened would read as success. Follow redirects
		// only for reads (GET, and HEAD which is bodiless by definition); a
		// redirected write is a loud configuration error (point the store URL
		// at the canonical origin).
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if via[0].Method == http.MethodGet || via[0].Method == http.MethodHead {
				return nil
			}
			return fmt.Errorf("%s redirected to %s: writes must target the canonical store URL", via[0].Method, req.URL.Redacted())
		},
	}

	return &HTTP{base: &base, client: client}, nil
}

// keyURL joins key under the store base URL. Keys are the store's own names
// (pack keys, assets/…, .locked) — plain ASCII path segments, no escaping
// needed. Redacted() keeps URL-userinfo passwords out of the debug log.
func (d *HTTP) keyURL(op, key string) *url.URL {
	u := d.base.JoinPath(key)
	slog.Debug("db "+op, "url", u.Redacted())
	return u
}

func (d *HTTP) newRequest(ctx context.Context, method string, u *url.URL, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, fmt.Errorf("building %s %s: %w", method, u.Redacted(), err)
	}
	if httpCfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+httpCfg.Token)
	}
	// Custom headers last: an explicit Authorization entry wins over Token.
	for k, v := range httpCfg.Headers {
		req.Header.Set(k, v)
	}
	return req, nil
}

// drainClose discards a bounded remainder of the body and closes it, letting
// the transport reuse the connection.
//
// Every non-Get caller closes through here, which `bodyclose` cannot see: it
// matches a literal Close() on the response body and does not follow the value
// into a helper. So each `defer drainClose(resp.Body)` site carries a suppression
// directive naming bodyclose and pointing back at this function. (Those three
// are the only place the directive is spelled out: golangci parses the token
// anywhere in a comment — with or without a space after the slashes — so
// quoting it in prose here would register a fourth, malformed one.) Inlining
// the two lines at all three call sites would satisfy the linter and lose the
// shared drain — the connection reuse is the point, not the Close.
func drainClose(rc io.ReadCloser) {
	io.Copy(io.Discard, io.LimitReader(rc, 4<<10)) //nolint:errcheck // best-effort drain
	rc.Close()
}

func (d *HTTP) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	u := d.keyURL("read", key)
	req, err := d.newRequest(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http get %s: %w", u.Redacted(), err)
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		drainClose(resp.Body)
		return nil, errMissing("key not found on "+u.Redacted()+":", key)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		drainClose(resp.Body)
		return nil, fmt.Errorf("http get %s: %s", u.Redacted(), resp.Status)
	}
	return resp.Body, nil
}

func (d *HTTP) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	return d.put(ctx, key, r, ignoreExisting, ObjectMeta{})
}

// AtomicPut is a plain overwriting PUT (mirrors S3): the server makes the
// object visible atomically on completion.
func (d *HTTP) AtomicPut(ctx context.Context, key string, r io.Reader, meta ObjectMeta) error {
	return d.put(ctx, key, r, true, meta)
}

// Version and PutIfVersion are UNSUPPORTED on a plain HTTP store, and that is a
// judgement, not an omission. A WebDAV-ish endpoint may well return an ETag and
// may well honour If-Match — but it may equally return one and ignore the other,
// and there is no in-band way to tell the two apart. A conditional write that
// silently degrades to an unconditional one is worse than none at all: the
// caller believes it holds a guarantee it does not. Reporting
// errors.ErrUnsupported makes the caller fall back to a plain AtomicPut, which
// is exactly what this backend did before and what it can honestly promise.
func (d *HTTP) Version(context.Context, string) (string, error) {
	return "", errors.ErrUnsupported
}

func (d *HTTP) PutIfVersion(context.Context, string, io.Reader, ObjectMeta, string) (string, error) {
	return "", errors.ErrUnsupported
}

// List is UNSUPPORTED for the same reason, one level up: HTTP has no portable
// listing verb. WebDAV's PROPFIND is an extension a plain object endpoint need
// not implement, an S3-compatible one wants a query string this backend does
// not speak, and a directory-index HTML page is a rendering, not an API.
// Guessing wrong here is worse than declining: a sweep that believes an empty
// listing means an empty store deletes nothing today and, in a caller less
// careful than the GC, could conclude the opposite tomorrow. Callers keep the
// fallback they had — the GC its low-water drain, `srr frontend update` its
// sitemap.
func (d *HTTP) List(context.Context, string) ([]string, error) {
	return nil, errors.ErrUnsupported
}

// put is the shared write core, mirroring S3's: Content-Type from meta, then
// contentTypeForKey (db.gz + pack names → application/gzip), then the
// application/octet-stream default; Content-Encoding only when meta sets it
// (never on packs — the reader gunzips manually, see contentTypeGzip);
// Cache-Control from the writer↔CDN contract; and `If-None-Match: *` as the
// exclusive-create condition. A server that ignores conditional requests
// overwrites — exclusive create (the .locked marker) is then best-effort.
func (d *HTTP) put(ctx context.Context, key string, r io.Reader, ignoreExisting bool, meta ObjectMeta) error {
	cacheControl := cacheControlForKey(key)
	u := d.keyURL("write", key)
	req, err := d.newRequest(ctx, http.MethodPut, u, r)
	if err != nil {
		return err
	}
	if !ignoreExisting {
		req.Header.Set("If-None-Match", "*")
	}

	contentType := meta.ContentType
	if contentType == "" {
		contentType = contentTypeForKey(key)
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	req.Header.Set("Content-Type", contentType)
	if meta.ContentEncoding != "" {
		req.Header.Set("Content-Encoding", meta.ContentEncoding)
	}
	if cacheControl != "" {
		req.Header.Set("Cache-Control", cacheControl)
	}

	resp, err := d.client.Do(req) //nolint:bodyclose // closed by the deferred drainClose below
	if err != nil {
		return fmt.Errorf("http put %s: %w", u.Redacted(), err)
	}
	defer drainClose(resp.Body)
	if resp.StatusCode == http.StatusPreconditionFailed && !ignoreExisting {
		return fmt.Errorf("key %q already exists on %s: %w", key, u.Redacted(), os.ErrExist)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("http put %s: %s", u.Redacted(), resp.Status)
	}
	return nil
}

// Stat returns the object's size via a HEAD request; a missing key is (0, nil)
// per the Backend contract. A server that omits Content-Length on HEAD
// (chunked/unknown, reported as -1) counts as 0 — accounting is best-effort on
// plain HTTP stores.
func (d *HTTP) Stat(ctx context.Context, key string) (int64, error) {
	u := d.keyURL("stat", key)
	req, err := d.newRequest(ctx, http.MethodHead, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := d.client.Do(req) //nolint:bodyclose // closed by the deferred drainClose below
	if err != nil {
		return 0, fmt.Errorf("http head %s: %w", u.Redacted(), err)
	}
	defer drainClose(resp.Body)
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		slog.Debug("db not found", "key", u.Redacted())
		return 0, errMissing("http head "+u.Redacted()+":", key)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return 0, fmt.Errorf("http head %s: %s", u.Redacted(), resp.Status)
	}
	// A server that omits Content-Length reports -1; clamp to 0. That is a
	// PRESENT object of unknown size, not an absent one — the 404/410 arm above
	// is the only absence answer, which is what lets a nil error prove presence.
	return max(0, resp.ContentLength), nil
}

func (d *HTTP) Rm(ctx context.Context, key string) error {
	u := d.keyURL("delete", key)
	req, err := d.newRequest(ctx, http.MethodDelete, u, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req) //nolint:bodyclose // closed by the deferred drainClose below
	if err != nil {
		return fmt.Errorf("http delete %s: %w", u.Redacted(), err)
	}
	defer drainClose(resp.Body)
	// Rm is contractually silent on missing keys (the GC sweeps re-delete a
	// trailing window of already-gone names on purpose).
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		slog.Debug("db not found", "key", u.Redacted())
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("http delete %s: %s", u.Redacted(), resp.Status)
	}
	return nil
}

// Close releases this handle. It deliberately does NOT flush idle connections
// any more: the pool is memoized per config (httpTransportFor) and shared with
// every other handle on this store, so flushing it here would discard live
// keep-alives a concurrent serve request is about to reuse — the same mistake
// the shared DefaultTransport made, one scope smaller. Idle sockets are reaped
// by the transport's own IdleConnTimeout, and by process exit.
func (d *HTTP) Close() error { return nil }
