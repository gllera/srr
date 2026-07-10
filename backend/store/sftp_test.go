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
