package store

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
)

type Cache struct {
	remote Backend
	local  *Local
	valid  bool
	// compromised is set when wipeSubdir failed mid-version-bump and we can no
	// longer trust on-disk cache contents to match remote. Reads bypass the
	// local cache and writes are skipped for the rest of the process so we
	// don't extend the inconsistency. Next process retries the wipe from
	// scratch — eventually self-heals once the underlying blocker (perms,
	// EBUSY, etc.) is gone.
	compromised bool
}

// cacheSubdir keys the cache by storeURL so multiple stores share one
// SRR_CACHE root without colliding.
func cacheSubdir(cacheDir, storeURL string) string {
	hash := sha256.Sum256([]byte(storeURL))
	return filepath.Join(cacheDir, fmt.Sprintf("%x", hash[:8]))
}

func NewCache(remote Backend, cacheDir, storeURL string) (*Cache, error) {
	subdir := cacheSubdir(cacheDir, storeURL)
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		return nil, fmt.Errorf("creating cache directory %s: %w", subdir, err)
	}
	return &Cache{
		remote: remote,
		local:  &Local{path: subdir},
	}, nil
}

func drainClose(rc io.ReadCloser, err error) ([]byte, error) {
	if rc != nil {
		defer rc.Close()
	}
	if err != nil {
		return nil, err
	}
	if rc == nil {
		return nil, nil
	}
	return io.ReadAll(rc)
}

// Rm on failure so a stale prior entry isn't served while remote has the new
// content (c.valid=true after a successful db.gz update would otherwise hide
// the staleness).
func (c *Cache) cacheLocally(ctx context.Context, key string, data []byte) {
	if c.compromised {
		return
	}
	if err := c.local.AtomicPut(ctx, key, bytes.NewReader(data)); err != nil {
		slog.Warn("cache write failed", "key", key, "error", err)
		if rmErr := c.local.Rm(ctx, key); rmErr != nil {
			slog.Warn("cache evict failed", "key", key, "error", rmErr)
		}
	}
}

func (c *Cache) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	if key == "db.gz" {
		return c.getDB(ctx, ignoreMissing)
	}

	base := path.Base(key)
	useCache := !c.compromised && (c.valid || (base != "true.gz" && base != "false.gz"))

	if useCache {
		if rc, err := c.local.Get(ctx, key, true); rc != nil && err == nil {
			slog.Debug("cache hit", "key", key)
			return rc, nil
		}
	}

	data, err := drainClose(c.remote.Get(ctx, key, ignoreMissing))
	if err != nil || data == nil {
		return nil, err
	}

	c.cacheLocally(ctx, key, data)
	return io.NopCloser(bytes.NewReader(data)), nil
}

// readVersion extracts `version` from a gzip-compressed db.gz body. ok=false
// signals a parse failure so the caller can distinguish "parsed cleanly and
// got 0" (legitimate fresh deployment) from "couldn't parse" (transient bad
// response). Treating malformed as 0 would falsely trip a wipe whenever the
// cached side had a real non-zero version.
func readVersion(gzData []byte) (version int, ok bool) {
	if len(gzData) == 0 {
		return 0, false
	}
	r, err := gzip.NewReader(bytes.NewReader(gzData))
	if err != nil {
		return 0, false
	}
	defer r.Close()
	var v struct {
		Version int `json:"version"`
	}
	if err := json.NewDecoder(r).Decode(&v); err != nil {
		return 0, false
	}
	return v.Version, true
}

// wipeSubdir removes everything under the cache root so a new version starts
// from a clean slate. Always attempts MkdirAll afterwards so a partial
// RemoveAll (one file removed, another not) still leaves a usable directory
// for subsequent writes — the caller distinguishes wipe failure via the
// returned error.
func (c *Cache) wipeSubdir() error {
	removeErr := os.RemoveAll(c.local.path)
	if mkErr := os.MkdirAll(c.local.path, 0o755); mkErr != nil {
		return mkErr
	}
	return removeErr
}

func (c *Cache) getDB(ctx context.Context, ignoreMissing bool) (io.ReadCloser, error) {
	remoteData, err := drainClose(c.remote.Get(ctx, "db.gz", ignoreMissing))
	if err != nil {
		return nil, err
	}
	if remoteData == nil {
		return nil, nil
	}

	cachedData, _ := drainClose(c.local.Get(ctx, "db.gz", true))

	c.valid = bytes.Equal(cachedData, remoteData)
	if c.valid {
		return io.NopCloser(bytes.NewReader(remoteData)), nil
	}

	// Bytes differ. Only when both sides parsed cleanly and disagree on
	// version do we need a full wipe — bytes.Equal=true already implies same
	// version since version is part of the gzipped JSON. A parse failure
	// (malformed remote) must NOT trigger a wipe, or a transient CDN glitch
	// would nuke the local pack cache.
	if cachedData != nil {
		remoteV, remoteOk := readVersion(remoteData)
		cachedV, cachedOk := readVersion(cachedData)
		if remoteOk && cachedOk && remoteV != cachedV {
			if err := c.wipeSubdir(); err != nil {
				// Without the bypass, useCache=true for finalized packs (N.gz)
				// would still serve the partially-wiped, old-version pack files.
				slog.Warn("cache wipe failed; bypassing local cache for this run", "error", err)
				c.compromised = true
				return io.NopCloser(bytes.NewReader(remoteData)), nil
			}
			slog.Info("cache version changed, wiped", "from", cachedV, "to", remoteV)
		}
	}

	slog.Debug("cache invalidated")
	c.cacheLocally(ctx, "db.gz", remoteData)
	return io.NopCloser(bytes.NewReader(remoteData)), nil
}

func (c *Cache) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}

	if err := c.remote.Put(ctx, key, bytes.NewReader(data), ignoreExisting); err != nil {
		return err
	}

	c.cacheLocally(ctx, key, data)
	return nil
}

func (c *Cache) AtomicPut(ctx context.Context, key string, r io.Reader) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}

	if err := c.remote.AtomicPut(ctx, key, bytes.NewReader(data)); err != nil {
		return err
	}

	c.cacheLocally(ctx, key, data)
	return nil
}

func (c *Cache) Rm(ctx context.Context, key string) error {
	if err := c.remote.Rm(ctx, key); err != nil {
		return err
	}

	c.local.Rm(ctx, key)
	return nil
}

func (c *Cache) Close() error {
	return c.remote.Close()
}
