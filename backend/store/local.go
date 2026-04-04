package store

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
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

func (d *Local) Get(_ context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	file := d.localPath("read", key)
	f, err := os.Open(file)
	if os.IsNotExist(err) && ignoreMissing {
		return nil, nil
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

func (d *Local) Put(_ context.Context, key string, r io.Reader, ignoreExisting bool) error {
	file := d.localPath("write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}
	fs, err := os.OpenFile(file, writeOpenFlags(ignoreExisting), 0o644)
	if err != nil {
		return fmt.Errorf("opening file %s: %w", file, err)
	}
	defer fs.Close()

	if _, err := io.Copy(fs, r); err != nil {
		return fmt.Errorf("writing file %s: %w", file, err)
	}
	return nil
}

func (d *Local) AtomicPut(_ context.Context, key string, r io.Reader) error {
	file := d.localPath("atomic write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}
	tmpFile := file + ".tmp"

	fs, err := os.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("opening file %s: %w", tmpFile, err)
	}

	if _, err := io.Copy(fs, r); err != nil {
		fs.Close()
		return fmt.Errorf("writing file %s: %w", tmpFile, err)
	}

	if err := fs.Close(); err != nil {
		return fmt.Errorf("closing file %s: %w", tmpFile, err)
	}

	if err := os.Rename(tmpFile, file); err != nil {
		return fmt.Errorf("renaming %s to %s: %w", tmpFile, file, err)
	}
	return nil
}

func (d *Local) Rm(_ context.Context, key string) error {
	file := d.localPath("delete", key)

	if err := os.Remove(file); err != nil {
		if os.IsNotExist(err) {
			slog.Warn("db not found", "key", file)
		} else {
			return fmt.Errorf("removing %s: %w", file, err)
		}
	}
	return nil
}

func (d *Local) Close() error {
	return nil
}
