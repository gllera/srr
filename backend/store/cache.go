package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
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

func (c *Cache) Get(ctx context.Context, key string, ignoreMissing bool) ([]byte, error) {
	if key == "db.gz" {
		return c.getDB(ctx, ignoreMissing)
	}

	base := path.Base(key)
	useCache := c.valid || (base != "true.gz" && base != "false.gz")

	if useCache {
		if data, err := c.local.Get(ctx, key, true); data != nil && err == nil {
			slog.Debug("cache hit", "key", key)
			return data, nil
		}
	}

	data, err := c.remote.Get(ctx, key, ignoreMissing)
	if err != nil || data == nil {
		return data, err
	}

	if putErr := c.local.Put(ctx, key, data, true); putErr != nil {
		slog.Warn("cache write failed", "key", key, "error", putErr)
	}
	return data, nil
}

func (c *Cache) getDB(ctx context.Context, ignoreMissing bool) ([]byte, error) {
	remoteData, err := c.remote.Get(ctx, "db.gz", ignoreMissing)
	if err != nil {
		return nil, err
	}

	cachedData, _ := c.local.Get(ctx, "db.gz", true)
	c.valid = bytes.Equal(cachedData, remoteData)
	if !c.valid {
		slog.Debug("cache invalidated")
	}

	if remoteData != nil {
		c.local.Put(ctx, "db.gz", remoteData, true)
	}

	return remoteData, nil
}

func (c *Cache) Put(ctx context.Context, key string, val []byte, ignoreExisting bool) error {
	if err := c.remote.Put(ctx, key, val, ignoreExisting); err != nil {
		return err
	}

	if putErr := c.local.Put(ctx, key, val, true); putErr != nil {
		slog.Warn("cache write failed", "key", key, "error", putErr)
	}
	return nil
}

func (c *Cache) AtomicPut(ctx context.Context, key string, val []byte) error {
	if err := c.remote.AtomicPut(ctx, key, val); err != nil {
		return err
	}

	if putErr := c.local.Put(ctx, key, val, true); putErr != nil {
		slog.Warn("cache write failed", "key", key, "error", putErr)
	}
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
