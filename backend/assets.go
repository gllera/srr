package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"srrb/store"
)

// assetFetcher uploads files into the store backend under a content-hash key,
// returning the relative key. The same key for given bytes makes uploads
// overwrite-safe and idempotent: it backs the end-of-pipeline self-hosting step
// (see UploadCacheRef).
type assetFetcher struct {
	be       store.Backend
	maxBytes int64
}

// assetPrefix is the reserved store prefix for self-hosted media, analogous to
// idx/ and data/. The frontend resolves keys under this prefix against the
// pack base.
const assetPrefix = "assets/"

// newAssetFetcher builds the run's asset uploader. maxKB caps a single file's
// size.
func newAssetFetcher(be store.Backend, maxKB int) *assetFetcher {
	return &assetFetcher{
		be:       be,
		maxBytes: int64(maxKB) * (1 << 10),
	}
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

// contentHashKey derives the relative store key (assets/<2>/<16><ext>) from the
// file's content hash plus an extension recovered from the reference path.
// Content-addressed, so identical bytes from any source dedup to one key; the
// layout is part of the writer↔reader contract (the frontend resolves keys
// under assetPrefix against the pack base).
func contentHashKey(localname string, sum [32]byte) string {
	h := hex.EncodeToString(sum[:])
	return assetPrefix + h[:2] + "/" + h[:16] + path.Ext(localname)
}
