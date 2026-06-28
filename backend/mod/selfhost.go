package mod

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// #selfhost downloads an item's remote <img>/<video>/<audio> media into the
// fetch run's shared cache dir and rewrites each reference to a "#"-marker, so
// the end-of-pipeline upload step (main.Feed.fetch -> RewriteAttrs ->
// assetFetcher.UploadCacheRef) peeks, converts via SRR_ASSET_PROCESS, and
// content-hash uploads it to assets/. The mod itself stores/converts nothing.
//
// Place it AFTER #default (recipe pipe ["#default", "#selfhost"]): it then downloads
// only sanitizer-approved media, and its markers (incl. <video poster>) never
// round-trip through #sanitize. Network-bound, so it honours the fetch context.
//
// Fail-open per asset: a bad URL, non-2xx, oversize, SSRF-blocked dial, or write
// error leaves the original remote URL in place (WARN). It is a no-op when the
// fetch context carries no cache dir (srr preview / the Validate sentinel).
//
// Parameters tune the per-asset fetch (defaults below): "timeout" (Go duration)
// and "maxbody" (byte size). A malformed/unknown parameter is a hard error.
//
//	#selfhost timeout=120s maxbody=128MiB
const (
	selfhostTimeout   = 120 * time.Second
	selfhostMaxBody   = 128 << 20
	selfhostUserAgent = "Mozilla/5.0 (compatible; SRR/1.0; +media-self-host)"
)

// MaxAssetSize is the self-hosted-object size cap in bytes (--max-asset-size),
// set by main before the fetch run. #selfhost enforces it HERE, at download: a
// body exceeding it is left as its remote URL (fail-open), so the cap is spent
// before the bytes hit disk and the upload step can trust the cache file without
// re-checking. It clamps the per-pipeline maxbody (the effective download cap is
// min(maxbody, MaxAssetSize)). Zero means unset (only maxbody applies).
var MaxAssetSize int64

func init() {
	Register("selfhost", func() Processor {
		// One SSRF-guarded client per Module (per fetch worker via procPool):
		// media URLs come from attacker-controlled feed content, so dials to
		// private/loopback/link-local addresses are refused.
		client := &http.Client{Transport: SafeTransport()}
		return func(ctx context.Context, p Params, i *RawItem) error {
			timeout, err := p.Duration("timeout", selfhostTimeout)
			if err != nil {
				return err
			}
			maxBody, err := p.Bytes("maxbody", selfhostMaxBody)
			if err != nil {
				return err
			}
			if err := p.only("timeout", "maxbody"); err != nil {
				return err
			}
			// The self-host object cap is enforced at download: clamp the download
			// limit to it so an over-cap asset is never written to the cache (the
			// upload step trusts whatever lands there).
			if MaxAssetSize > 0 && MaxAssetSize < maxBody {
				maxBody = MaxAssetSize
			}

			cacheDir := cacheDirFromContext(ctx)
			if cacheDir == "" {
				// No run cache dir (preview / Validate): nothing to download into
				// and no uploader downstream. Leave content as-is.
				return nil
			}
			// Cheap guard: skip the HTML parse when there is no media element.
			if !strings.Contains(i.Content, "<img") &&
				!strings.Contains(i.Content, "<video") &&
				!strings.Contains(i.Content, "<audio") {
				return nil
			}

			content, err := walkAssetAttrs(i.Content, mediaAttrs, func(val string) (string, bool, error) {
				marker, ok := downloadToCache(ctx, client, cacheDir, val, timeout, maxBody)
				return marker, ok, nil // fail-open: ok=false leaves the URL; never errors
			})
			if err != nil {
				// An HTML render error from the walk: fail open, keep original.
				slog.Warn("selfhost: content rewrite failed; keeping original", "link", i.Link, "err", err)
				return nil
			}
			i.Content = content
			return nil
		}
	})
}

// downloadToCache fetches an absolute http(s) media URL into cacheDir under a
// URL-hashed filename and returns the "#<filename>" marker the upload step
// consumes. It returns ("", false) — leaving the original value — for any
// non-fatal condition (relative/non-http ref, fetch failure, non-2xx, oversize,
// write error), so one bad asset never fails the item. A file already present
// for the URL is reused (download dedup; upload dedup is UploadCacheRef's).
func downloadToCache(ctx context.Context, client *http.Client, cacheDir, rawURL string, timeout time.Duration, maxBody int64) (string, bool) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false // relative assets/ keys, #fragments, data: — not ours
	}

	sum := sha256.Sum256([]byte(rawURL))
	name := hex.EncodeToString(sum[:8]) + cleanExt(u.Path) // 8 bytes -> 16 hex
	full := filepath.Join(cacheDir, name)

	// URL-level download cache: a URL already fetched (this run or a prior one)
	// is reused as-is.
	if _, err := os.Stat(full); err == nil {
		return "#" + name, true
	}

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", selfhostUserAgent)

	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("selfhost: download failed; keeping remote URL", "url", rawURL, "err", err)
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		slog.Warn("selfhost: non-2xx; keeping remote URL", "url", rawURL, "status", resp.StatusCode)
		return "", false
	}

	// LimitReader to maxBody+1 so an over-cap body is detected (n > maxBody) and
	// rejected rather than silently truncated and stored.
	if !streamToCacheFile(full, io.LimitReader(resp.Body, maxBody+1), maxBody) {
		return "", false
	}
	return "#" + name, true
}

// streamToCacheFile spools r to a temp file in full's directory and atomically
// renames it onto full. Returns false (removing the temp file) on an over-cap
// body (n > maxBody) or any IO error, so the caller leaves the original URL.
// The temp file shares full's directory so the rename is intra-directory and
// atomic; a cancelled/failed download never leaves a partial file at full.
func streamToCacheFile(full string, r io.Reader, maxBody int64) bool {
	tmp, err := os.CreateTemp(filepath.Dir(full), ".selfhost-*")
	if err != nil {
		slog.Warn("selfhost: temp create failed", "err", err)
		return false
	}
	tmpName := tmp.Name()
	n, copyErr := io.Copy(tmp, r)
	closeErr := tmp.Close()
	if copyErr != nil || closeErr != nil || n > maxBody {
		os.Remove(tmpName)
		if n > maxBody {
			slog.Warn("selfhost: asset over size cap; keeping remote URL", "max", maxBody)
		} else {
			// A genuine IO failure (mid-body reset, flush error): fail-open like
			// the rest of the module, but never silently — ops needs to know why
			// an asset wasn't self-hosted.
			slog.Warn("selfhost: cache write failed; keeping remote URL", "copy_err", copyErr, "close_err", closeErr)
		}
		return false
	}
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		slog.Warn("selfhost: rename failed", "err", err)
		return false
	}
	return true
}

// cleanExt returns the URL path's extension when it is a short, clean
// alphanumeric extension (2-6 chars incl. the dot), else "". A query-laden or
// extension-less URL yields ""; asset-peek/asset-process identify the real type
// by bytes regardless, so the cache extension is only a hint.
func cleanExt(p string) string {
	ext := path.Ext(p)
	if len(ext) < 2 || len(ext) > 6 {
		return ""
	}
	for _, r := range ext[1:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	return strings.ToLower(ext)
}
