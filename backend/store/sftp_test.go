package store

import (
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// newPipeSFTPClient wires an in-process sftp server (serving the real
// filesystem, rooted nowhere — keys resolve under the returned t.TempDir() base)
// to a real *sftp.Client via NewClientPipe, skipping the ssh transport that
// dialSFTPSession would dial. kill drops the SERVER, which is the only way to
// simulate a peer going away: closing the client alone deadlocks on its own recv
// loop, which lives until the server's write pipe closes.
func newPipeSFTPClient(t *testing.T) (client *sftp.Client, base string, kill func()) {
	t.Helper()
	cr, sw := io.Pipe() // client reads ← server writes
	sr, cw := io.Pipe() // server reads ← client writes

	srv, err := sftp.NewServer(pipeRWC{Reader: sr, WriteCloser: sw})
	if err != nil {
		t.Fatalf("sftp.NewServer: %v", err)
	}
	go srv.Serve() //nolint:errcheck // exits when the pipes close

	client, err = sftp.NewClientPipe(cr, cw)
	if err != nil {
		t.Fatalf("sftp.NewClientPipe: %v", err)
	}
	// Order matters: client.Close() waits for its recv loop, which only exits
	// once the server's write pipe closes — so shut the server down first.
	t.Cleanup(func() {
		srv.Close()
		client.Close()
	})

	// Wait() returns once the client's recv loop has seen the server go, so a
	// killed session is observably dead the moment kill returns.
	kill = func() {
		srv.Close()
		client.Wait() // returns the shutdown error; the wait is what we want
	}
	return client, t.TempDir(), kill
}

// setupSFTPPipe puts the production SFTP struct on top of that client. The
// session is NOT in the sftpSessions memo, so this cleanup owns its teardown —
// d.Close() would be a harmless no-op either way (see SFTP.Close), but nothing
// here should rely on a handle closing anything.
func setupSFTPPipe(t *testing.T) (*SFTP, string) {
	t.Helper()
	client, base, _ := newPipeSFTPClient(t)
	return &SFTP{path: base, host: "test", client: client}, base
}

func TestSFTPPutGetRoundTrip(t *testing.T) {
	d, _ := setupSFTPPipe(t)
	if err := d.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, err := d.Get(ctx, "a.txt")
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
	rc, err := d.Get(ctx, "sub/deep/x.txt")
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
	rc, _ := d.Get(ctx, "f.txt")
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
	rc, _ := d.Get(ctx, "atomic.txt")
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
	rc, err := d.Get(ctx, "f.txt")
	if rc != nil {
		rc.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Get after Rm err = %v, want errors.Is(err, fs.ErrNotExist)", err)
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
	// A missing key is an fs.ErrNotExist-wrapped error, never a silent
	// zero — a nil error from Stat has to PROVE presence. Pinned for all
	// four backends at once in TestBackendMissingKeyConformance; kept here
	// so a single-backend edit trips its own test too.
	if _, err := d.Stat(ctx, "missing.bin"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Stat(missing) err = %v, want errors.Is(err, fs.ErrNotExist)", err)
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
	rc, err := d.Get(ctx, "other.txt")
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

// --- session memo ----------------------------------------------------------

// sftpDialCounter records what the substituted dialer did.
type sftpDialCounter struct {
	dials int
	base  string // temp-dir root the most recently dialed session serves
	kill  func() // drops that session's server, i.e. its peer
}

// withSFTPSessionMemo isolates the package session memo for one test and swaps
// in a dialer handing out in-process pipe sessions, so a test can count dials
// without standing up an ssh server. The counter is written inside
// sftpSessionFor's critical section, so the concurrent test reads it race-free
// once its goroutines have joined.
func withSFTPSessionMemo(t *testing.T) *sftpDialCounter {
	t.Helper()
	savedSessions, savedDial := sftpSessions, sftpDialSession
	sftpSessions = map[sftpSessionKey]*sftpSession{}
	c := &sftpDialCounter{}
	sftpDialSession = func(sftpSessionKey, *url.URL) (*sftpSession, error) {
		client, base, kill := newPipeSFTPClient(t)
		c.dials++
		c.base, c.kill = base, kill
		// sshClient stays nil: the pipe IS the established transport.
		return &sftpSession{client: client}, nil
	}
	t.Cleanup(func() {
		sftpSessions, sftpDialSession = savedSessions, savedDial
	})
	return c
}

// The whole point of the memo: a store.Open — one per serve API request, one per
// fetch cycle — stops paying a TCP connect + SSH handshake + subsystem open.
// Anything that changes WHO WE ARE TO WHOM keys a separate session; two stores
// under different credentials must never share one.
func TestSFTPSessionMemoizedPerIdentity(t *testing.T) {
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")

	first, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	second, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor(again): %v", err)
	}
	if first != second {
		t.Error("a second lookup under one identity got a different session")
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 — the second lookup redialed", c.dials)
	}

	others := map[string]sftpSessionKey{
		"user":         {addr: "h:22", user: "bob"},
		"addr":         {addr: "other:22", user: "alice"},
		"config":       {addr: "h:22", user: "alice", cfg: SFTPConfig{Password: "pw"}},
		"url password": {addr: "h:22", user: "alice", urlPassword: "pw"},
	}
	for name, other := range others {
		s, err := sftpSessionFor(other, u)
		if err != nil {
			t.Fatalf("sftpSessionFor(%s): %v", name, err)
		}
		if s == first {
			t.Errorf("a different %s shared the first identity's session", name)
		}
	}
	if want := 1 + len(others); c.dials != want {
		t.Errorf("dials = %d, want %d — one per distinct identity", c.dials, want)
	}
}

// A memoized session outlives the handle that dialed it, so a server restart or
// an idle disconnect leaves a corpse in the map. The liveness probe is what
// keeps it from being handed out.
func TestSFTPSessionRedialedWhenDead(t *testing.T) {
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")

	dead, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	c.kill() // the peer went away between two Opens
	if dead.alive() {
		t.Fatal("the probe still calls a session with no peer alive")
	}

	live, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor(after death): %v", err)
	}
	if live == dead {
		t.Fatal("a dead session was handed out again")
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 (the redial)", c.dials)
	}
	if !live.alive() {
		t.Error("the replacement session does not answer")
	}
}

// The lock spans the dial so a burst of concurrent Opens performs ONE handshake
// and shares it. This is also the shape -race is here for: one *sftp.Client
// serving several handles at once.
func TestSFTPSessionConcurrentLookupsDialOnce(t *testing.T) {
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")

	var wg sync.WaitGroup
	got := make([]*sftpSession, 8)
	errs := make([]error, len(got))
	for i := range got {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], errs[i] = sftpSessionFor(key, u)
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("lookup %d: %v", i, err)
		}
		if got[i] != got[0] {
			t.Fatalf("lookup %d got a different session", i)
		}
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 — concurrent Opens must share one handshake", c.dials)
	}
}

// Close is a ref-release, not a teardown: the session belongs to the memo, so a
// handle that closes must leave every other handle — and the next Open — with a
// working connection. Closing it here is exactly what made every store.Open pay
// a fresh handshake.
func TestSFTPCloseLeavesTheSharedSessionUp(t *testing.T) {
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")

	sess, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	first := &SFTP{path: c.base, host: "test", client: sess.client}
	if err := first.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	again, err := sftpSessionFor(key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor(after Close): %v", err)
	}
	if again != sess {
		t.Error("the closed handle's session was torn down or replaced")
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 — Close must not force a redial", c.dials)
	}
	second := &SFTP{path: c.base, host: "test", client: again.client}
	rc, err := second.Get(ctx, "a.txt")
	if err != nil {
		t.Fatalf("Get on the shared session after a peer handle closed: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
}
