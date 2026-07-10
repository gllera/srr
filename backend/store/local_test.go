package store

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

// errCloseFailure is the sentinel returned by the fake file's Close.
var errCloseFailure = errors.New("injected close error")

// fakeWriteCloser records whether Close was called and optionally errors on it.
// It embeds an io.Writer so io.Copy succeeds; the Close error fires on the first
// call and is a no-op on subsequent calls (mirrors the real file behaviour and
// guards against double-close panics).
type fakeWriteCloser struct {
	w       io.Writer
	closeN  int
	closeOK bool // when false, first Close returns errCloseFailure
}

func (f *fakeWriteCloser) Write(p []byte) (int, error) { return f.w.Write(p) }

func (f *fakeWriteCloser) Close() error {
	f.closeN++
	if !f.closeOK && f.closeN == 1 {
		return errCloseFailure
	}
	return nil
}

// TestLocalPutReturnsCloseError asserts that Local.Put propagates a close-time
// flush error.  The test uses the localOpenFile var-seam (same pattern as
// finalGzip in db_pack.go) to inject a WriteCloser whose Close fails.
func TestLocalPutReturnsCloseError(t *testing.T) {
	var fwc fakeWriteCloser

	// Inject the fake; restore the original when done.
	orig := localOpenFile
	t.Cleanup(func() { localOpenFile = orig })
	localOpenFile = func(name string, flag int, perm os.FileMode) (io.WriteCloser, error) {
		fwc = fakeWriteCloser{w: io.Discard, closeOK: false}
		return &fwc, nil
	}

	b, _ := setupLocalStore(t)
	err := b.Put(ctx, "key.txt", strings.NewReader("payload"), true)
	if !errors.Is(err, errCloseFailure) {
		t.Fatalf("Put should return close error; got: %v", err)
	}
	// Confirm no double-close: the error path must not call Close a second time
	// beyond the single explicit close.
	if fwc.closeN != 1 {
		t.Errorf("Close called %d time(s), want exactly 1", fwc.closeN)
	}
}

// TestLocalPutNoDoubleCloseOnCopyError asserts that when io.Copy fails the
// explicit fs.Close() in the error branch doesn't panic on a double-close (the
// defer is gone; there is exactly one Close call in this branch too).
func TestLocalPutNoDoubleCloseOnCopyError(t *testing.T) {
	orig := localOpenFile
	t.Cleanup(func() { localOpenFile = orig })

	var fwc fakeWriteCloser
	localOpenFile = func(name string, flag int, perm os.FileMode) (io.WriteCloser, error) {
		fwc = fakeWriteCloser{w: io.Discard, closeOK: true}
		return &fwc, nil
	}

	errCopy := errors.New("copy error")
	badReader := &errorReader{err: errCopy}

	b, _ := setupLocalStore(t)
	err := b.Put(ctx, "key2.txt", badReader, true)
	if !errors.Is(err, errCopy) {
		t.Fatalf("Put should return copy error; got: %v", err)
	}
	if fwc.closeN != 1 {
		t.Errorf("Close called %d time(s) on copy error, want exactly 1", fwc.closeN)
	}
}

// errorReader always returns err from Read.
type errorReader struct{ err error }

func (r *errorReader) Read(_ []byte) (int, error) { return 0, r.err }

func TestLocalStat(t *testing.T) {
	b, _ := setupLocalStore(t)
	if err := b.Put(ctx, "sub/obj.bin", strings.NewReader("12345"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n, err := b.Stat(ctx, "sub/obj.bin"); err != nil || n != 5 {
		t.Errorf("Stat = (%d, %v), want (5, nil)", n, err)
	}
	// A missing key is (0, nil) per the Backend contract (silent like Rm).
	if n, err := b.Stat(ctx, "missing.bin"); err != nil || n != 0 {
		t.Errorf("Stat(missing) = (%d, %v), want (0, nil)", n, err)
	}
}
