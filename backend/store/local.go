package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func init() {
	Register("", newLocal)
}

type Local struct {
	path string
}

func newLocal(_ context.Context, u *url.URL) (Backend, error) {
	info, err := os.Stat(u.Path)
	if err != nil {
		return nil, fmt.Errorf("checking path %s: %w", u.Path, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("path %s is not a directory", u.Path)
	}

	return &Local{
		path: u.Path,
	}, nil
}

func (d *Local) localPath(op, key string) string {
	full := filepath.Join(d.path, key)
	slog.Debug("db "+op, "url", full)
	return full
}

func (d *Local) Get(_ context.Context, key string) (io.ReadCloser, error) {
	file := d.localPath("read", key)
	f, err := os.Open(file)
	if isNotExist(err) {
		return nil, errMissing("opening file", file)
	}
	if err != nil {
		return nil, fmt.Errorf("opening file %s: %w", file, err)
	}
	return f, nil
}

func writeOpenFlags(ignoreExisting bool) int {
	if ignoreExisting {
		return os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	return os.O_WRONLY | os.O_CREATE | os.O_EXCL
}

func (d *Local) ensureDir(file string) error {
	if dir := filepath.Dir(file); dir != d.path {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating directory %s: %w", dir, err)
		}
	}
	return nil
}

// localOpenFile is a var to allow test seams (mirrors the finalGzip pattern).
var localOpenFile = func(name string, flag int, perm os.FileMode) (io.WriteCloser, error) {
	return os.OpenFile(name, flag, perm)
}

func (d *Local) Put(_ context.Context, key string, r io.Reader, ignoreExisting bool) error {
	file := d.localPath("write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}
	fs, err := localOpenFile(file, writeOpenFlags(ignoreExisting), 0o644)
	if err != nil {
		return fmt.Errorf("opening file %s: %w", file, err)
	}

	if _, err := io.Copy(fs, r); err != nil {
		fs.Close()
		return fmt.Errorf("writing file %s: %w", file, err)
	}
	if err := fs.Close(); err != nil {
		return fmt.Errorf("closing file %s: %w", file, err)
	}
	return nil
}

// AtomicPut ignores meta: local files have no stored Content-Type/-Encoding —
// the static server stamps response headers by extension at request time.
func (d *Local) AtomicPut(_ context.Context, key string, r io.Reader, _ ObjectMeta) error {
	file := d.localPath("atomic write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}
	tmpFile := uniqueTempName(file)

	fs, err := os.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("opening file %s: %w", tmpFile, err)
	}
	// Sweep AFTER creating our own staging file, so the sweep can read the
	// store's clock off it (see sweepTempLeftovers). Trade-off of that
	// ordering: a directory where the temp create ITSELF keeps failing (gone
	// read-only, disk full) is never swept, so self-healing is gated on the
	// operation that is failing. Acceptable — a store that cannot be written
	// to has a louder problem than a stale staging file.
	sweepTempLeftovers(filepath.Dir(file), filepath.Base(tmpFile))

	// Remove the staging file on every failure path (matching SFTP.AtomicPut), so
	// a recurring failure (e.g. a full disk hit every serve --interval cycle)
	// can't accumulate orphaned <key>.tmp.<pid>.<n> files — nothing else sweeps
	// them (the pack GC only knows the pack-name grammar).
	if _, err := io.Copy(fs, r); err != nil {
		fs.Close()
		_ = os.Remove(tmpFile)
		return fmt.Errorf("writing file %s: %w", tmpFile, err)
	}

	// fsync the bytes before the rename so a crash/power-loss can't publish a
	// truncated or zero-length file under the real key — db.gz is the one mutable
	// index the whole store depends on, and finalized packs are cached forever.
	if err := fs.Sync(); err != nil {
		fs.Close()
		_ = os.Remove(tmpFile)
		return fmt.Errorf("syncing file %s: %w", tmpFile, err)
	}
	if err := fs.Close(); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("closing file %s: %w", tmpFile, err)
	}

	if err := os.Rename(tmpFile, file); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("renaming %s to %s: %w", tmpFile, file, err)
	}
	// fsync the parent directory so the rename itself is durable across a crash.
	if dir, err := os.Open(filepath.Dir(file)); err == nil {
		_ = dir.Sync()
		dir.Close()
	}
	return nil
}

// Version digests the file's bytes. A filesystem exposes no entity tag, and the
// cheap surrogates (size, mtime, inode) all lie on some filesystem or other —
// coarse mtimes, inode reuse, a rename that carries the temp file's stamp — so
// the token is simply what is stored. Content-addressing has no ABA hazard here
// because the only key that uses it is the root, whose generation counter is
// monotone: it can never come back to bytes it already had.
func (d *Local) Version(_ context.Context, key string) (string, error) {
	file := d.localPath("version", key)
	f, err := os.Open(file)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("opening file %s: %w", file, err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("reading file %s: %w", file, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// PutIfVersion is a BEST-EFFORT compare-and-swap: a local store has no atomic
// conditional write, so this checks and then renames. What it buys is real but
// bounded — the window shrinks from "the whole cycle" to the instant between the
// check and the rename — and it is bounded further by the two things that
// already serialize local writers: the leased `.locked` marker and the
// exclusive-create manifest publish, which no peer can pass concurrently. A
// local store is one filesystem on one host; the multi-writer race this guards
// belongs to object storage, where s3.go implements it for real.
func (d *Local) PutIfVersion(ctx context.Context, key string, r io.Reader, meta ObjectMeta, want string) (string, error) {
	cur, err := d.Version(ctx, key)
	if err != nil {
		return "", err
	}
	if cur != want {
		return "", fmt.Errorf("%s: %w", d.localPath("conditional write", key), ErrPreconditionFailed)
	}
	h := sha256.New()
	if err := d.AtomicPut(ctx, key, io.TeeReader(r, h), meta); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// sweepTempLeftovers removes uniqueTempName staging files a hard-killed
// predecessor stranded in dir (its rename never ran; the per-process unique
// name means nothing ever overwrites them and no GC speaks them — see
// tempSweepMaxAge, which also age-gates the sweep off any live writer's
// in-flight staging file).
//
// ownTemp names the caller's OWN staging file, just created in dir: its mtime
// in this very listing is the reference "now". Both sides of the age
// comparison then come from one clock and one call — the store's, which on an
// NFS/SMB mount is the server's, not this host's. A skewed clock would
// otherwise make every in-flight staging file look ancient, and concurrent
// asset uploads inside ONE process already put several in a shard. If our own
// entry is missing from the listing the sweep is skipped: no reference, no
// judgement. Best-effort and silent on errors — janitor work must never fail
// or noise up the AtomicPut that triggered it.
func sweepTempLeftovers(dir, ownTemp string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var now time.Time
	for _, e := range entries {
		if e.Name() == ownTemp {
			if fi, err := e.Info(); err == nil {
				now = fi.ModTime()
			}
			break
		}
	}
	if now.IsZero() {
		return
	}
	for _, e := range entries {
		if e.Name() == ownTemp || !e.Type().IsRegular() || !isTempLeftover(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil || !staleTemp(fi.ModTime(), now) {
			continue
		}
		file := filepath.Join(dir, e.Name())
		if err := os.Remove(file); err == nil {
			slog.Info("removed stale atomic-write leftover", "file", file)
		}
	}
}

// Stat returns the file's size. A missing key is an error wrapping
// fs.ErrNotExist per the Backend contract; a nil error therefore PROVES the
// file exists, zero-byte included.
func (d *Local) Stat(_ context.Context, key string) (int64, error) {
	file := d.localPath("stat", key)
	fi, err := os.Stat(file)
	if isNotExist(err) {
		slog.Debug("db not found", "key", file)
		return 0, errMissing("stat file", file)
	}
	if err != nil {
		return 0, fmt.Errorf("stat file %s: %w", file, err)
	}
	return fi.Size(), nil
}

func (d *Local) Rm(_ context.Context, key string) error {
	file := d.localPath("delete", key)
	return rmErr(os.Remove(file), file)
}

// List walks the prefix's directory and returns the store-relative keys under
// it. Only regular files count — a directory is not an object, and neither is a
// symlink or a device node someone dropped in the tree.
//
// Two error decisions, both the Backend contract's: a prefix naming no
// directory is an EMPTY set with a nil error (a prefix is not a key, so
// fs.ErrNotExist would be a lie about a question nobody asked), and an entry
// that vanished mid-walk — a concurrent GC deleting exactly what we are
// enumerating — is skipped rather than failing the whole listing.
func (d *Local) List(_ context.Context, prefix string) ([]string, error) {
	root := filepath.Join(d.path, filepath.FromSlash(listDir(prefix)))
	slog.Debug("db list", "url", root, "prefix", prefix)

	var out []string
	err := filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if isNotExist(err) {
				return nil
			}
			return err
		}
		if !e.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(d.path, p)
		if err != nil {
			return err
		}
		if key := filepath.ToSlash(rel); strings.HasPrefix(key, prefix) {
			out = append(out, key)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("listing %s: %w", root, err)
	}
	// WalkDir's order is per-directory lexical, which is NOT lexical over the
	// joined keys ("a.txt" sorts before "a/b" as a string but after it in the
	// walk), so the contract's ordering is imposed here.
	slices.Sort(out)
	return out, nil
}

func (d *Local) Close() error {
	return nil
}
