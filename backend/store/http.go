package store

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
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

func newHTTP(_ context.Context, u *url.URL) (Backend, error) {
	base := *u
	base.Path = strings.TrimRight(base.Path, "/")

	// No client-level timeout: pack/asset uploads may legitimately run long and
	// every operation already carries the caller's context (run cancellation).
	transport := http.DefaultTransport
	if httpCfg.Insecure {
		t, ok := http.DefaultTransport.(*http.Transport)
		if !ok {
			t = &http.Transport{}
		}
		t = t.Clone()
		t.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		transport = t
	}

	client := &http.Client{
		Transport: transport,
		// net/http silently replays a 301/302/303-redirected PUT/DELETE as a
		// bodiless GET and reports the redirected GET's status — a write or
		// delete that never happened would read as success. Follow redirects
		// only for reads; a redirected write is a loud configuration error
		// (point the store URL at the canonical origin).
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if via[0].Method == http.MethodGet {
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
func drainClose(rc io.ReadCloser) {
	io.Copy(io.Discard, io.LimitReader(rc, 4<<10)) //nolint:errcheck // best-effort drain
	rc.Close()
}

func (d *HTTP) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
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
		if ignoreMissing {
			return nil, nil
		}
		return nil, fmt.Errorf("key %q not found on %s", key, u.Redacted())
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

	resp, err := d.client.Do(req)
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

func (d *HTTP) Rm(ctx context.Context, key string) error {
	u := d.keyURL("delete", key)
	req, err := d.newRequest(ctx, http.MethodDelete, u, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
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

func (d *HTTP) Close() error {
	d.client.CloseIdleConnections()
	return nil
}
