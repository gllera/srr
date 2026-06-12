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
	"os"
	"path"
	"path/filepath"
	"strings"

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
		// truncated asset never serves. Use WithoutCancel so the cleanup still
		// runs when the fetch is being torn down (SIGTERM/SIGINT cancelled ctx),
		// otherwise the partial object leaks into the assets/ prefix.
		_ = a.be.Rm(context.WithoutCancel(ctx), key)
		return "", fmt.Errorf("asset %q exceeds %d bytes", srcURL, a.maxBytes)
	}
	return key, nil
}

// UploadCacheRef resolves localname inside cacheDir, uploads the file to the
// store under a content-hash key if it is not already present, and returns that
// key. It backs the end-of-pipeline upload step (inlined in feed.fetch): an
// out-of-repo ingest fetcher downloads files into the run's shared cache
// dir and refers to them by relative path in item content; SRR owns the assets/
// key (sha256 of the bytes, so identical content from any source dedups) and
// the upload, so the fetcher needs no store credentials. Idempotent: a key
// already in the store is not re-uploaded.
//
// Guards (localname comes from item content, which may be attacker-influenced):
// the resolved path must stay within cacheDir (no "..", no symlinked escape),
// must be a regular file, and must not exceed the media size cap.
func (a *assetFetcher) UploadCacheRef(ctx context.Context, cacheDir, localname string) (string, error) {
	if localname == "" {
		return "", fmt.Errorf("empty asset reference")
	}

	full := filepath.Join(cacheDir, filepath.FromSlash(localname))

	// Reject symlinks and non-regular files outright (Lstat does not follow the
	// final component).
	fi, err := os.Lstat(full)
	if err != nil {
		return "", fmt.Errorf("stat asset %q: %w", localname, err)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("asset %q is not a regular file", localname)
	}

	// Containment: resolve symlinks on both sides and confirm the file stays
	// under the cache dir, so neither a "../" reference nor a symlinked path
	// component can point the upload at an arbitrary file.
	root, err := filepath.EvalSymlinks(cacheDir)
	if err != nil {
		return "", fmt.Errorf("resolve cache dir: %w", err)
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", fmt.Errorf("resolve asset %q: %w", localname, err)
	}
	if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("asset %q escapes cache dir", localname)
	}

	if a.maxBytes > 0 && fi.Size() > a.maxBytes {
		return "", fmt.Errorf("asset %q exceeds %d bytes (size %d)", localname, a.maxBytes, fi.Size())
	}

	sum, err := hashFile(full)
	if err != nil {
		return "", fmt.Errorf("hash asset %q: %w", localname, err)
	}
	key := contentHashKey(localname, sum)

	// Upload only if absent: a content-hash key is stable, so a key already in
	// the store holds identical bytes (skip the redundant Put, and the upstream
	// download was already skipped by the fetcher's cache hit).
	if rc, err := a.be.Get(ctx, key, true); err != nil {
		return "", fmt.Errorf("check asset %q: %w", key, err)
	} else if rc != nil {
		rc.Close()
		return key, nil
	}

	f, err := os.Open(full)
	if err != nil {
		return "", fmt.Errorf("open asset %q: %w", localname, err)
	}
	defer f.Close()
	if err := a.be.Put(ctx, key, f, true); err != nil {
		return "", fmt.Errorf("store asset %q: %w", key, err)
	}
	return key, nil
}

// hashFile streams path through sha256 without buffering the whole file.
func hashFile(path string) ([32]byte, error) {
	var sum [32]byte
	f, err := os.Open(path)
	if err != nil {
		return sum, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return sum, err
	}
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

// contentHashKey derives the relative store key from the file's content hash
// plus an extension recovered from the reference path. Mirrors assetKey's
// layout (assets/<2>/<16><ext>) but is content-addressed rather than URL-keyed.
func contentHashKey(localname string, sum [32]byte) string {
	h := hex.EncodeToString(sum[:])
	return assetPrefix + h[:2] + "/" + h[:16] + path.Ext(localname)
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
