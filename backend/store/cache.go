package store

import (
	"bytes"
	"context"
	"crypto/sha256"
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
}

func NewCache(remote Backend, cacheDir, storeURL string) (*Cache, error) {
	hash := sha256.Sum256([]byte(storeURL))
	subdir := filepath.Join(cacheDir, fmt.Sprintf("%x", hash[:8]))

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

func (c *Cache) cacheLocally(ctx context.Context, key string, data []byte) {
	if putErr := c.local.Put(ctx, key, bytes.NewReader(data), true); putErr != nil {
		slog.Warn("cache write failed", "key", key, "error", putErr)
	}
}

func (c *Cache) Get(ctx context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	if key == "db.gz" {
		return c.getDB(ctx, ignoreMissing)
	}

	base := path.Base(key)
	useCache := c.valid || (base != "true.gz" && base != "false.gz")

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

func (c *Cache) getDB(ctx context.Context, ignoreMissing bool) (io.ReadCloser, error) {
	remoteData, err := drainClose(c.remote.Get(ctx, "db.gz", ignoreMissing))
	if err != nil {
		return nil, err
	}

	cachedData, _ := drainClose(c.local.Get(ctx, "db.gz", true))

	c.valid = bytes.Equal(cachedData, remoteData)
	if !c.valid {
		slog.Debug("cache invalidated")
	}

	if remoteData != nil {
		c.cacheLocally(ctx, "db.gz", remoteData)
	}

	if remoteData == nil {
		return nil, nil
	}
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
