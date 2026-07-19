package store

import (
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/pkg/sftp"
)

// --- pure-function tests (no server) ---------------------------------------

// withSFTPCfg swaps the package-level config for one test. Every test also
// neutralizes a developer's running ssh-agent so the auth chain is
// deterministic.
func withSFTPCfg(t *testing.T, cfg SFTPConfig) {
	t.Helper()
	saved := sftpCfg
	sftpCfg = cfg
	t.Cleanup(func() { sftpCfg = saved })
	t.Setenv("SSH_AUTH_SOCK", "")
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

func TestSftpUserPrecedence(t *testing.T) {
	cases := []struct {
		name, rawURL, cfgUser, envUser, want string
	}{
		{"url wins", "sftp://alice@h/p", "bob", "carol", "alice"},
		{"config beats env", "sftp://h/p", "bob", "carol", "bob"},
		{"env USER fallback", "sftp://h/p", "", "carol", "carol"},
		{"root default", "sftp://h/p", "", "", "root"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withSFTPCfg(t, SFTPConfig{User: c.cfgUser})
			t.Setenv("USER", c.envUser)
			if got := sftpUser(mustURL(t, c.rawURL)); got != c.want {
				t.Errorf("sftpUser = %q, want %q", got, c.want)
			}
		})
	}
}

func TestSftpHostKeyInsecure(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{Insecure: true})
	cb, err := sftpHostKeyCallback()
	if err != nil || cb == nil {
		t.Errorf("insecure callback = (%v, %v), want (non-nil, nil)", cb, err)
	}
}

func TestSftpHostKeyFromFile(t *testing.T) {
	// A syntactically valid single-entry known_hosts (ssh-ed25519 test key).
	kh := filepath.Join(t.TempDir(), "known_hosts")
	line := "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGTl1rqGHbT/1jRQHCwSBWvSXxe0Tw0Zw6LC25SBNyh9\n"
	if err := os.WriteFile(kh, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	withSFTPCfg(t, SFTPConfig{KnownHostsFile: kh})
	cb, err := sftpHostKeyCallback()
	if err != nil || cb == nil {
		t.Errorf("callback from file = (%v, %v), want (non-nil, nil)", cb, err)
	}
}

func TestSftpHostKeyMissingFile(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{KnownHostsFile: filepath.Join(t.TempDir(), "nope")})
	if _, err := sftpHostKeyCallback(); err == nil {
		t.Error("missing known_hosts file should error")
	}
}

func TestSftpAuthURLPassword(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{})
	methods, cleanup, err := sftpAuthMethods(mustURL(t, "sftp://u:pw@h/p"))
	if err != nil || len(methods) == 0 || cleanup == nil {
		t.Errorf("auth = (%d methods, %v), want url-password method", len(methods), err)
	}
}

func TestSftpAuthConfigPassword(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{Password: "pw"})
	t.Setenv("HOME", t.TempDir()) // no ~/.ssh keys
	methods, _, err := sftpAuthMethods(mustURL(t, "sftp://h/p"))
	if err != nil || len(methods) == 0 {
		t.Errorf("auth = (%d methods, %v), want config-password method", len(methods), err)
	}
}

func TestSftpAuthPrivateKeyMissing(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{PrivateKey: filepath.Join(t.TempDir(), "nope")})
	_, _, err := sftpAuthMethods(mustURL(t, "sftp://h/p"))
	if err == nil || !strings.Contains(err.Error(), "reading private key") {
		t.Errorf("err = %v, want reading-private-key error", err)
	}
}

func TestSftpAuthPrivateKeyParseError(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "garbage")
	if err := os.WriteFile(bad, []byte("not a pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	withSFTPCfg(t, SFTPConfig{PrivateKey: bad})
	_, _, err := sftpAuthMethods(mustURL(t, "sftp://h/p"))
	if err == nil || !strings.Contains(err.Error(), "parsing private key") {
		t.Errorf("err = %v, want parsing-private-key error", err)
	}
}

func TestSftpAuthNoneAvailable(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{})
	t.Setenv("HOME", t.TempDir()) // empty: the ~/.ssh scan finds nothing
	_, _, err := sftpAuthMethods(mustURL(t, "sftp://h/p"))
	if err == nil || !strings.Contains(err.Error(), "no password, private key, or ssh-agent key") {
		t.Errorf("err = %v, want no-auth-available error", err)
	}
}

// --- op tests (in-process pkg/sftp server over pipes, no ssh layer) ---------

type pipeRWC struct {
	io.Reader
	io.WriteCloser
}

// setupSFTPPipe wires an in-process sftp server (serving the real filesystem,
// rooted nowhere — keys resolve under the returned t.TempDir() base) to the
// production SFTP struct via NewClientPipe, skipping the ssh transport that
// newSFTP would dial. NOTE: never call d.Close() here — sshClient is nil; the
// cleanup closes the sftp client and server directly.
func setupSFTPPipe(t *testing.T) (*SFTP, string) {
	t.Helper()
	cr, sw := io.Pipe() // client reads ← server writes
	sr, cw := io.Pipe() // server reads ← client writes

	srv, err := sftp.NewServer(pipeRWC{Reader: sr, WriteCloser: sw})
	if err != nil {
		t.Fatalf("sftp.NewServer: %v", err)
	}
	go srv.Serve() //nolint:errcheck // exits when the pipes close

	client, err := sftp.NewClientPipe(cr, cw)
	if err != nil {
		t.Fatalf("sftp.NewClientPipe: %v", err)
	}
	// Order matters: client.Close() waits for its recv loop, which only exits
	// once the server's write pipe closes — so shut the server down first.
	t.Cleanup(func() {
		srv.Close()
		client.Close()
	})

	base := t.TempDir()
	return &SFTP{path: base, host: "test", client: client}, base
}

func TestSFTPPutGetRoundTrip(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, err := d.Get(ctx, "a.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
}

func TestSFTPPutCreatesSubdirectories(t *testing.T) {
	d, base := setupSFTPPipe(t)
	if err := d.Put(ctx, "sub/deep/x.txt", strings.NewReader("nested"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "sub", "deep")); err != nil {
		t.Errorf("subdirectories should have been auto-created: %v", err)
	}
	rc, err := d.Get(ctx, "sub/deep/x.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "nested" {
		t.Errorf("content = %q, want %q", got, "nested")
	}
}

// TestSFTPPutExclusiveCreateReportsErrExist pins the store-lock 409 contract for
// the SFTP backend: an exclusive-create conflict must satisfy
// errors.Is(err, os.ErrExist) like S3/HTTP/local, so cmd_serve's writeErr maps
// it to the documented 409 "store is locked" instead of a raw 400. pkg/sftp
// maps EEXIST to the generic SSH_FX_FAILURE (SFTPv3 has no "already exists"
// status), so the raw client error does NOT — SFTP.Put must translate it.
func TestSFTPPutExclusiveCreateReportsErrExist(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Put(ctx, "lock", strings.NewReader(""), false); err != nil {
		t.Fatalf("Put(first): %v", err)
	}
	err := d.Put(ctx, "lock", strings.NewReader(""), false)
	if err == nil {
		t.Fatal("Put(ignoreExisting=false) on existing file should fail")
	}
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("err = %v; want errors.Is(err, os.ErrExist)", err)
	}
}

func TestSFTPPutOverwrite(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	for _, content := range []string{"first", "second"} {
		if err := d.Put(ctx, "f.txt", strings.NewReader(content), true); err != nil {
			t.Fatalf("Put(%q): %v", content, err)
		}
	}
	rc, _ := d.Get(ctx, "f.txt", false)
	if got := readAllClose(t, rc); got != "second" {
		t.Errorf("content = %q, want last write %q", got, "second")
	}
}

func TestSFTPAtomicPutNoTempFileRemains(t *testing.T) {
	d, base := setupSFTPPipe(t)
	if err := d.AtomicPut(ctx, "atomic.txt", strings.NewReader("content"), ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "atomic.txt.tmp")); !os.IsNotExist(err) {
		t.Error("temp file should not remain after AtomicPut")
	}
	rc, _ := d.Get(ctx, "atomic.txt", false)
	if got := readAllClose(t, rc); got != "content" {
		t.Errorf("content = %q, want %q", got, "content")
	}
}

// A failure after the temp file is created must not leave the .tmp orphan
// behind: unlike the local FS, an SFTP server has nothing to sweep it.
func TestSFTPAtomicPutFailureRemovesTempFile(t *testing.T) {
	d, base := setupSFTPPipe(t)
	wantErr := errors.New("injected read failure")
	if err := d.AtomicPut(ctx, "atomic.txt", iotest.ErrReader(wantErr), ObjectMeta{}); err == nil {
		t.Fatal("AtomicPut with a failing reader should return an error")
	}
	if _, err := os.Stat(filepath.Join(base, "atomic.txt.tmp")); !os.IsNotExist(err) {
		t.Error("temp file should not remain after a failed AtomicPut")
	}
	if _, err := os.Stat(filepath.Join(base, "atomic.txt")); !os.IsNotExist(err) {
		t.Error("destination file should not exist after a failed AtomicPut")
	}
}

func TestSFTPGetMissingIgnored(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	rc, err := d.Get(ctx, "missing.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get(missing, ignoreMissing=true) = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestSFTPGetMissingErrors(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	rc, err := d.Get(ctx, "missing.txt", false)
	if rc != nil {
		rc.Close()
	}
	if err == nil {
		t.Error("Get(missing, ignoreMissing=false) should return error")
	}
}

func TestSFTPRmSilentOnMissing(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Rm(ctx, "missing.txt"); err != nil {
		t.Errorf("Rm(missing) = %v, want nil (silent-on-missing contract)", err)
	}
}

func TestSFTPRmExisting(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Put(ctx, "f.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := d.Rm(ctx, "f.txt"); err != nil {
		t.Fatalf("Rm: %v", err)
	}
	rc, err := d.Get(ctx, "f.txt", true)
	if err != nil || rc != nil {
		t.Errorf("Get after Rm = (%v, %v), want (nil, nil)", rc, err)
	}
}

func TestSFTPStat(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Put(ctx, "sub/obj.bin", strings.NewReader("12345"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n, err := d.Stat(ctx, "sub/obj.bin"); err != nil || n != 5 {
		t.Errorf("Stat = (%d, %v), want (5, nil)", n, err)
	}
	// A missing key is (0, nil) per the Backend contract (silent like Rm).
	if n, err := d.Stat(ctx, "missing.bin"); err != nil || n != 0 {
		t.Errorf("Stat(missing) = (%d, %v), want (0, nil)", n, err)
	}
}

// The SFTP AtomicPut sweeps stale staging leftovers exactly as the Local one
// does — the two implementations are separate code, so the contract is pinned
// on both. A leftover older than tempSweepMaxAge goes; a fresh one (which may
// be another live writer's in-flight staging file) stays.
func TestSFTPAtomicPutSweepsStaleTempLeftovers(t *testing.T) {
	d, base := setupSFTPPipe(t)
	stale := filepath.Join(base, "db.gz.tmp.99999.1")
	fresh := filepath.Join(base, "db.gz.tmp.99999.2")
	for _, f := range []string{stale, fresh} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-tempSweepMaxAge - time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	if err := d.AtomicPut(ctx, "other.txt", strings.NewReader("content"), ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale temp leftover survived the sweep (err=%v), want removed", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("fresh temp file swept (err=%v), want kept by the age gate", err)
	}
	// The write itself must be unaffected by the janitor work.
	rc, err := d.Get(ctx, "other.txt", false)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got := readAllClose(t, rc); got != "content" {
		t.Errorf("content = %q, want %q", got, "content")
	}
}

// Same clock-source pin as the Local backend's, and it matters more here: the
// server's mtimes are the ones that count, and an SFTP server's clock is not
// this host's. The own staging file is stamped 48h ahead, so a leftover written
// at host-now is only swept if the reference "now" came from that listing entry
// rather than from time.Now(). The missing-reference half is pinned too — no
// reference, no judgement.
func TestSFTPSweepTempLeftoversTakesNowFromOwnTemp(t *testing.T) {
	d, base := setupSFTPPipe(t)
	own := "db.gz.tmp.99999.1"
	leftover := filepath.Join(base, "db.gz.tmp.11111.7")
	for _, f := range []string{filepath.Join(base, own), leftover} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ahead := time.Now().Add(48 * time.Hour)
	if err := os.Chtimes(filepath.Join(base, own), ahead, ahead); err != nil {
		t.Fatal(err)
	}

	d.sweepTempLeftovers(base, own)

	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Errorf("leftover survived (err=%v); the sweep aged it against this host's clock, not the server's own-temp mtime", err)
	}
	if _, err := os.Stat(filepath.Join(base, own)); err != nil {
		t.Errorf("the caller's own staging file was swept (err=%v); it must always be skipped", err)
	}

	// With no own-temp entry in the listing there is no server-clock reading, so
	// nothing may be judged stale — and an unreadable directory stays silent.
	aged := filepath.Join(base, "db.gz.tmp.22222.8")
	if err := os.WriteFile(aged, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-tempSweepMaxAge - time.Hour)
	if err := os.Chtimes(aged, old, old); err != nil {
		t.Fatal(err)
	}
	d.sweepTempLeftovers(base, "db.gz.tmp.98765.4") // never created
	if _, err := os.Stat(aged); err != nil {
		t.Errorf("an ancient leftover was swept with no reference mtime (err=%v); want no judgement", err)
	}
	d.sweepTempLeftovers(filepath.Join(base, "no-such-dir"), own)
}
