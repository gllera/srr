package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"

	"srrb/store"
)

// assetFetcher implements mod.Assets: it downloads an object by URL and
// streams the body into the store backend under a URL-hash key, returning the
// relative key. The same key for a given source URL makes downloads
// overwrite-safe and idempotent within a run.
type assetFetcher struct {
	be       store.Backend
	client   *http.Client
	maxBytes int64
}

// assetPrefix is the reserved store prefix for self-hosted media, analogous to
// idx/ and data/. The frontend resolves keys under this prefix against the
// pack base.
const assetPrefix = "assets/"

// newAssetFetcher builds the run's download capability. maxKB caps a single
// object's size.
func newAssetFetcher(be store.Backend, client *http.Client, maxKB int) *assetFetcher {
	return &assetFetcher{
		be:       be,
		client:   client,
		maxBytes: int64(maxKB) * (1 << 10),
	}
}

// Fetch GETs srcURL and streams it into the store under a sha256(srcURL) key,
// returning the relative key (e.g. "assets/ab/cd1234....jpg"). Rejects
// non-http(s) URLs and over-cap bodies; on any failure returns ("", err) so
// the caller keeps the original URL.
func (a *assetFetcher) Fetch(ctx context.Context, srcURL string) (string, error) {
	u, err := url.Parse(srcURL)
	if err != nil {
		return "", fmt.Errorf("parse asset url %q: %w", srcURL, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported asset url scheme %q", u.Scheme)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srcURL, nil)
	if err != nil {
		return "", fmt.Errorf("asset request %q: %w", srcURL, err)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("asset get %q: %w", srcURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("asset get %q: status %d", srcURL, resp.StatusCode)
	}
	if a.maxBytes > 0 && resp.ContentLength > a.maxBytes {
		return "", fmt.Errorf("asset %q exceeds %d bytes (content-length %d)", srcURL, a.maxBytes, resp.ContentLength)
	}

	key := assetKey(srcURL, u.Path, resp.Header.Get("Content-Type"))

	var body io.Reader = resp.Body
	if a.maxBytes > 0 {
		body = io.LimitReader(resp.Body, a.maxBytes+1)
	}
	counted := &countingReader{r: body}

	if err := a.be.Put(ctx, key, counted, true); err != nil {
		return "", fmt.Errorf("store asset %q: %w", key, err)
	}
	if a.maxBytes > 0 && counted.n > a.maxBytes {
		// The body overflowed the cap mid-stream; drop the partial object so a
		// truncated asset never serves.
		_ = a.be.Rm(ctx, key)
		return "", fmt.Errorf("asset %q exceeds %d bytes", srcURL, a.maxBytes)
	}
	return key, nil
}

// assetKey derives the relative store key from the source URL hash plus an
// extension recovered from the URL path or the response Content-Type.
func assetKey(srcURL, urlPath, contentType string) string {
	sum := sha256.Sum256([]byte(srcURL))
	h := hex.EncodeToString(sum[:])

	ext := path.Ext(urlPath)
	if ext == "" {
		if mt, _, err := mime.ParseMediaType(contentType); err == nil {
			if exts, _ := mime.ExtensionsByType(mt); len(exts) > 0 {
				ext = exts[0]
			}
		}
	}
	return assetPrefix + h[:2] + "/" + h[:16] + ext
}

// countingReader tracks how many bytes have been read so the caller can detect
// an io.LimitReader overflow after streaming completes.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
