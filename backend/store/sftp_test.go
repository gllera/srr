package store

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
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
// here should rely on a handle closing anything. A nil url is what marks the
// handle as memo-less: its retries re-use the session rather than redial.
func setupSFTPPipe(t *testing.T) (*SFTP, string) {
	t.Helper()
	client, base, _ := newPipeSFTPClient(t)
	return &SFTP{path: base, host: "test", sess: &sftpSession{client: client}}, base
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

	d.sweepTempLeftovers(d.conn(), base, own)

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
	d.sweepTempLeftovers(d.conn(), base, "db.gz.tmp.98765.4") // never created
	if _, err := os.Stat(aged); err != nil {
		t.Errorf("an ancient leftover was swept with no reference mtime (err=%v); want no judgement", err)
	}
	d.sweepTempLeftovers(d.conn(), filepath.Join(base, "no-such-dir"), own)
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
// the ENTRY's critical section, so the concurrent test — which hammers a single
// identity, i.e. a single entry — reads it race-free once its goroutines have
// joined. A test dialing several identities concurrently would need its own
// synchronisation; TestSFTPWedgedIdentityDoesNotBlockOthers has it.
func withSFTPSessionMemo(t *testing.T) *sftpDialCounter {
	t.Helper()
	savedSessions, savedDial := sftpSessions, sftpDialSession
	sftpSessions = map[sftpSessionKey]*sftpEntry{}
	c := &sftpDialCounter{}
	sftpDialSession = func(context.Context, sftpSessionKey, *url.URL) (*sftpSession, error) {
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

	first, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	second, err := sftpSessionFor(ctx, key, u)
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
		s, err := sftpSessionFor(ctx, other, u)
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

// Containment: a peer that accepts the connection and then answers nothing must
// stall only the goroutines that want THAT identity. The memo used to hold one
// process-global mutex across the probe and the dial, so a single black-holed
// server queued every store.Open in the process behind it — including ones for
// unrelated backends — with no context to cancel and no deadline to expire.
func TestSFTPWedgedIdentityDoesNotBlockOthers(t *testing.T) {
	savedSessions, savedDial := sftpSessions, sftpDialSession
	sftpSessions = map[sftpSessionKey]*sftpEntry{}
	t.Cleanup(func() { sftpSessions, sftpDialSession = savedSessions, savedDial })

	wedged := sftpSessionKey{addr: "wedged:22", user: "alice"}
	release := make(chan struct{})
	entered := make(chan struct{})
	var once sync.Once
	sftpDialSession = func(_ context.Context, key sftpSessionKey, _ *url.URL) (*sftpSession, error) {
		if key == wedged {
			once.Do(func() { close(entered) })
			<-release // the peer never answers
		}
		client, _, _ := newPipeSFTPClient(t)
		return &sftpSession{client: client}, nil
	}
	t.Cleanup(func() { close(release) })

	go func() { _, _ = sftpSessionFor(ctx, wedged, mustURL(t, "sftp://alice@wedged/p")) }()
	<-entered // the wedged dial is now inside its critical section

	done := make(chan error, 1)
	go func() {
		_, err := sftpSessionFor(ctx, sftpSessionKey{addr: "healthy:22", user: "alice"},
			mustURL(t, "sftp://alice@healthy/p"))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("healthy identity: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a wedged identity's dial blocked an unrelated identity's Open — " +
			"the memo is serializing peer I/O on a process-global lock")
	}
}

// The probe must not be able to break the traffic it is asking about. A session
// is SHARED — pkg/sftp multiplexes every handle's requests over one SSH channel
// — so bounding the probe with conn.SetDeadline was the wrong instrument: an
// absolute deadline applies to all pending and future I/O on the connection, so
// a probe taking its full budget times out another worker's in-flight upload.
// (Reproduced directly: a SetDeadline on one end of a net.Pipe fails a
// concurrent Read with i/o timeout.)
//
// The invariant is asserted directly — "the probe never sets a deadline on the
// shared conn" — rather than through timing. A behavioural version is a trap: a
// probe that answers quickly clears its own deadline before the concurrent read
// notices, so the test passes against the very bug it exists to catch. The
// damage only lands when the probe is SLOW, which is precisely the case a fast
// unit test does not reproduce. So count the calls instead.
func TestSFTPProbeDoesNotDeadlineTheSharedTransport(t *testing.T) {
	client, _, kill := newPipeSFTPClient(t)
	a, b := net.Pipe()
	t.Cleanup(func() { a.Close(); b.Close() })
	spy := &deadlineSpy{Conn: a}
	s := &sftpSession{client: client, conn: spy}

	if got := s.probe(false); got != sessionHealthy {
		t.Fatalf("probe = %v, want sessionHealthy (the pipe server answers)", got)
	}
	// ...and on the unhealthy path too, which is where a deadline would be most
	// tempting and most destructive.
	kill()
	if got := s.probe(false); got == sessionHealthy {
		t.Fatalf("probe = %v, want a non-healthy answer after the peer died", got)
	}

	if n := spy.deadlines.Load(); n != 0 {
		t.Errorf("probe() called SetDeadline %d time(s) on the shared transport; want 0 — "+
			"the conn carries every other handle's in-flight I/O, so an absolute deadline "+
			"armed here times out their transfers, not just this probe", n)
	}
	_ = b
}

// deadlineSpy counts deadline calls on a conn without changing its behaviour.
type deadlineSpy struct {
	net.Conn
	deadlines atomic.Int32
}

func (c *deadlineSpy) SetDeadline(t time.Time) error {
	c.deadlines.Add(1)
	return c.Conn.SetDeadline(t)
}

func (c *deadlineSpy) SetReadDeadline(t time.Time) error {
	c.deadlines.Add(1)
	return c.Conn.SetReadDeadline(t)
}

func (c *deadlineSpy) SetWriteDeadline(t time.Time) error {
	c.deadlines.Add(1)
	return c.Conn.SetWriteDeadline(t)
}

// The freshness short-circuit: a session that answered moments ago is not
// probed at all. That is what keeps the probe away from exactly the sessions
// with live traffic to lose — and it must NOT apply to sftpSessionRefresh,
// which asks precisely because an op just failed.
func TestSFTPProbeTrustsRecentSuccess(t *testing.T) {
	client, _, kill := newPipeSFTPClient(t)
	s := &sftpSession{client: client}
	s.markOK()
	kill() // the peer is gone, but the stamp is fresh

	if got := s.probe(true); got != sessionHealthy {
		t.Errorf("probe(trustFresh) = %v, want sessionHealthy from the recent-success stamp", got)
	}
	if got := s.probe(false); got == sessionHealthy {
		t.Error("probe(false) trusted the stamp; refresh must do the real round trip")
	}
}

// A memoized session outlives the handle that dialed it, so a server restart or
// an idle disconnect leaves a corpse in the map. The liveness probe is what
// keeps it from being handed out.
func TestSFTPSessionRedialedWhenDead(t *testing.T) {
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")

	dead, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	c.kill() // the peer went away between two Opens
	if dead.probe(false) == sessionHealthy {
		t.Fatal("the probe still calls a session with no peer alive")
	}

	live, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor(after death): %v", err)
	}
	if live == dead {
		t.Fatal("a dead session was handed out again")
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 (the redial)", c.dials)
	}
	if live.probe(false) != sessionHealthy {
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
			got[i], errs[i] = sftpSessionFor(ctx, key, u)
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

// memoHandle is a production SFTP handle bound to a memoized session, i.e. the
// shape newSFTP builds: it carries the identity, so a connection-class failure
// can send it back to the memo for a redial. base stays the FIRST session's temp
// dir on purpose — a redialed pipe session serves the same real filesystem, so
// the handle's absolute paths keep resolving and the redial is observable as a
// dial count rather than as a lost store.
func memoHandle(t *testing.T, c *sftpDialCounter, key sftpSessionKey, u *url.URL) *SFTP {
	t.Helper()
	sess, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	return &SFTP{path: c.base, host: "test", key: key, u: u, sess: sess}
}

// The failure this whole step exists for: a fetch cycle opens the store ONCE and
// runs for minutes, so a peer that goes away mid-cycle used to fail not just the
// op that hit it but every op after it. One redial and one repeat, and the cycle
// carries on.
func TestSFTPRedialsAfterMidOperationConnectionLoss(t *testing.T) {
	withFastRetry(t)
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	u := mustURL(t, "sftp://alice@h/p")
	d := memoHandle(t, c, key, u)

	if err := d.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	c.kill() // the peer dies with the handle still open

	rc, err := d.Get(ctx, "a.txt")
	if err != nil {
		t.Fatalf("Get after the session died: %v — the handle never went back to the memo", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 (the redial)", c.dials)
	}

	// The handle adopted the replacement rather than redialing per op, and so did
	// the memo — the next Open must not pay for another handshake.
	if err := d.Put(ctx, "b.txt", strings.NewReader("more"), true); err != nil {
		t.Fatalf("Put on the redialed session: %v", err)
	}
	if _, err := sftpSessionFor(ctx, key, u); err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 — the redialed session must be the memoized one", c.dials)
	}
}

// A write recovers the same way, and it recovers WHOLE: the retry re-sends the
// body from the start, so what lands under an immutable name is never a prefix
// of it.
func TestSFTPAtomicPutRetriesWithTheCompleteBody(t *testing.T) {
	withFastRetry(t)
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	d := memoHandle(t, c, key, mustURL(t, "sftp://alice@h/p"))
	base := c.base
	c.kill()

	if err := d.AtomicPut(ctx, "pack.gz", strings.NewReader("packbytes"), ObjectMeta{}); err != nil {
		t.Fatalf("AtomicPut across a dead session: %v", err)
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 (the redial)", c.dials)
	}
	got, err := os.ReadFile(filepath.Join(base, "pack.gz"))
	if err != nil {
		t.Fatalf("reading the written object: %v", err)
	}
	if string(got) != "packbytes" {
		t.Errorf("stored %q, want the complete %q", got, "packbytes")
	}
	// Every attempt draws its own staging name and removes it, so a retried
	// write leaves nothing behind either.
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if isTempLeftover(e.Name()) {
			t.Errorf("staging file %q survived the retried AtomicPut", e.Name())
		}
	}
}

// An exclusive create is the `.locked` lease acquire and is NEVER retried: a
// repeat could find the marker this very process wrote a moment ago, report
// contention against itself, and wedge the writer until a human passes --force.
// The overwrite sibling right below it is the control — same handle, same dead
// session, and it does redial.
func TestSFTPExclusiveCreateIsNeverRetried(t *testing.T) {
	withFastRetry(t)
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "h:22", user: "alice"}
	d := memoHandle(t, c, key, mustURL(t, "sftp://alice@h/p"))
	c.kill()

	if err := d.Put(ctx, ".locked", strings.NewReader("{}"), false); err == nil {
		t.Fatal("Put(ignoreExisting=false) on a dead session should fail")
	}
	if c.dials != 1 {
		t.Fatalf("dials = %d, want 1 — an exclusive create must not be retried onto a fresh session", c.dials)
	}

	if err := d.Put(ctx, ".locked", strings.NewReader("{}"), true); err != nil {
		t.Fatalf("Put(overwrite) on the same dead session: %v", err)
	}
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 — an overwrite is idempotent and does retry", c.dials)
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

	sess, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	first := &SFTP{path: c.base, host: "test", sess: sess}
	if err := first.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	again, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor(after Close): %v", err)
	}
	if again != sess {
		t.Error("the closed handle's session was torn down or replaced")
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 — Close must not force a redial", c.dials)
	}
	second := &SFTP{path: c.base, host: "test", sess: again}
	rc, err := second.Get(ctx, "a.txt")
	if err != nil {
		t.Fatalf("Get on the shared session after a peer handle closed: %v", err)
	}
	if got := readAllClose(t, rc); got != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
}

// --- base-path validation ----------------------------------------------------

// newSFTP validates the store's base path THROUGH the handle it just built, so
// that one idempotent read gets the retry+redial ladder every other read on
// this backend has. It needs the ladder more than any of them: it is the FIRST
// thing to touch a session the memo hands out, and the memo hands one out
// WITHOUT probing whenever its last success is recent (probe's trustFresh
// short-circuit, which exists so a busy session is never disturbed). A peer
// that died in that window therefore reaches an unretried Stat, and store.Open
// fails outright — where the pre-memo code, which dialed once per Open, simply
// connected.
func TestSFTPOpenRedialsWhenAFreshStampHidesADeadPeer(t *testing.T) {
	withFastRetry(t)
	withSFTPCfg(t, SFTPConfig{})
	c := withSFTPSessionMemo(t)

	// A real directory: the pipe sessions serve this host's filesystem, so the
	// store URL's path resolves for real on whichever session ends up answering.
	base := t.TempDir()
	u := mustURL(t, "sftp://alice@h"+base)
	key := sftpSessionKey{cfg: sftpCfg, addr: "h:22", user: "alice"}

	sess, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	sess.markOK() // an op just succeeded...
	c.kill()      // ...and the peer went away right after it

	if got := sess.probe(true); got != sessionHealthy {
		t.Fatalf("probe(trustFresh) = %s; this test needs the freshness short-circuit to hand "+
			"the dead session out unprobed", healthName(got))
	}

	b, err := newSFTP(ctx, u)
	if err != nil {
		t.Fatalf("newSFTP over a fresh-stamped dead session: %v — the base-path check statted "+
			"the memoized session directly instead of going through d.retry, so store.Open "+
			"fails where one redial would have served it", err)
	}
	t.Cleanup(func() { b.Close() })
	if c.dials != 2 {
		t.Errorf("dials = %d, want 2 — the base-path check's retry is what forces the redial", c.dials)
	}

	// The Open did not merely survive: the handle adopted the replacement, so it
	// comes back connected.
	if err := b.Put(ctx, "a.txt", strings.NewReader("data"), true); err != nil {
		t.Fatalf("Put on the reopened handle: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(base, "a.txt")); err != nil || string(got) != "data" {
		t.Errorf("stored (%q, %v), want (%q, nil)", got, err, "data")
	}
}

// The other half of routing that check through the retry: neither of its two
// verdicts may become a repeat. Both are definitive answers about the STORE's
// layout, not about the connection, and both messages are the ones an operator
// reads when a store URL is wrong — so they are pinned verbatim.
func TestSFTPOpenBadBasePathIsAnsweredOnce(t *testing.T) {
	withFastRetry(t)
	withSFTPCfg(t, SFTPConfig{})
	c := withSFTPSessionMemo(t)

	dir := t.TempDir()
	file := filepath.Join(dir, "regular")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "nope")

	cases := []struct {
		name, path, want string
	}{
		{"missing", missing, fmt.Sprintf("sftp base path %q does not exist", missing)},
		{"not a directory", file, fmt.Sprintf("sftp base path %q is not a directory", file)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, err := newSFTP(ctx, mustURL(t, "sftp://alice@h"+tc.path))
			if b != nil {
				b.Close()
			}
			if err == nil || err.Error() != tc.want {
				t.Fatalf("newSFTP err = %v, want exactly %q", err, tc.want)
			}
			if retryable(ctx, err) {
				t.Errorf("err = %v is classified retryable; a verdict about the store's layout "+
					"must never be repeated as though it were a dropped connection", err)
			}
		})
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 — a bad base path says nothing about the connection "+
			"and must not redial", c.dials)
	}
}

// --- the real dial path (in-process ssh server) -----------------------------

// withDialTimeout shrinks the connect budget for one test. The production 30s
// is a correctness bound — it must exceed the longest real handshake — so it is
// not a number a test can wait out; and both halves of the conn deadline (armed
// before the handshake, cleared after it) are only observable by outlasting it.
func withDialTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	saved := sftpDialTimeout
	sftpDialTimeout = d
	t.Cleanup(func() { sftpDialTimeout = saved })
}

// withProbeTimeout does the same for the liveness probe, whose timer arm is
// simply unreachable in a fast test at the production 10s.
func withProbeTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	saved := sftpProbeTimeout
	sftpProbeTimeout = d
	t.Cleanup(func() { sftpProbeTimeout = saved })
}

// newSSHSFTPServer stands up a REAL ssh server on loopback — ed25519 host key,
// password auth, the "sftp" subsystem — and returns its address.
//
// Every other test in this file substitutes the dialer through the
// sftpDialSession seam and hands out in-process pipe sessions, which is right
// for the memo tests but leaves dialSFTPSession itself with ZERO executed
// coverage: auth resolution, host-key policy, DialContext, ssh.NewClientConn,
// sftp.NewClient, and the two ends of the dial deadline. The server is ~50
// lines and the handshake is a few milliseconds on loopback, which is a cheap
// price for the one code path whose failure mode is invisible until production.
func newSSHSFTPServer(t *testing.T, password string) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("ssh.NewSignerFromKey: %v", err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if string(pass) != password {
				return nil, errors.New("bad password")
			}
			return nil, nil
		},
	}
	cfg.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return // the listener closed with the test
			}
			go serveSSHSFTP(nc, cfg)
		}
	}()
	return ln.Addr().String()
}

// serveSSHSFTP is the server half: one ssh connection, session channels only,
// pkg/sftp bolted onto whichever one asks for the "sftp" subsystem. Errors are
// dropped rather than reported — this is a peer, not an assertion, and it is
// routinely torn down mid-handshake when a test's listener closes.
func serveSSHSFTP(nc net.Conn, cfg *ssh.ServerConfig) {
	defer nc.Close()
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)

	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			return
		}
		go func() {
			for req := range chReqs {
				// A subsystem request's payload is the length-prefixed name.
				ok := req.Type == "subsystem" && len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp"
				if req.WantReply {
					_ = req.Reply(ok, nil)
				}
				if !ok {
					continue
				}
				srv, err := sftp.NewServer(ch)
				if err != nil {
					_ = ch.Close()
					return
				}
				go func() {
					_ = srv.Serve()
					_ = srv.Close()
					_ = ch.Close()
				}()
			}
		}()
	}
}

// The last line of dialSFTPSession is conn.SetDeadline(time.Time{}) — the CLEAR
// of the dial deadline — and nothing covered it. The deadline is ABSOLUTE and
// the conn it sits on is the session's for life (pkg/sftp multiplexes every
// handle over it), so losing that one line does not fail a dial: it kills every
// SFTP session exactly sftpDialTimeout after it was opened, i.e. 30s into a
// fetch cycle, in production only.
func TestSFTPDialClearsTheDialDeadline(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{Insecure: true})
	t.Setenv("HOME", t.TempDir()) // no ~/.ssh keys: the URL password alone
	withDialTimeout(t, 200*time.Millisecond)

	addr := newSSHSFTPServer(t, "pw")
	u := mustURL(t, "sftp://u:pw@"+addr+"/")
	key := sftpSessionKey{cfg: sftpCfg, addr: addr, user: "u", urlPassword: "pw"}

	sess, err := dialSFTPSession(ctx, key, u)
	if err != nil {
		t.Fatalf("dialSFTPSession against a real ssh server: %v", err)
	}
	t.Cleanup(sess.close)
	if sess.client == nil || sess.sshClient == nil || sess.conn == nil {
		t.Fatalf("session = %+v, want client, sshClient and conn all set", sess)
	}

	// Outlast the dial budget by a wide margin: a surviving absolute deadline
	// has fired by now and taken the shared transport down with it.
	time.Sleep(3 * sftpDialTimeout)

	if _, err := sess.client.Getwd(); err != nil {
		t.Fatalf("Getwd on a session dialed %v ago: %v — the dial deadline was never cleared, "+
			"so every SFTP session dies sftpDialTimeout after it is dialed", 3*sftpDialTimeout, err)
	}
}

// The other end of the same deadline: it must be ARMED before the handshake.
// ssh.ClientConfig.Timeout bounds net.Dial and nothing else (x/crypto/ssh spends
// it in ssh.Dial's net.DialTimeout call — ssh.NewClientConn never reads it), so
// a peer that completes the TCP connect and then never sends its version banner
// leaves the handshake blocked with nothing left to interrupt it.
func TestSFTPDialGivesUpOnASilentPeer(t *testing.T) {
	withSFTPCfg(t, SFTPConfig{Insecure: true})
	t.Setenv("HOME", t.TempDir())
	withDialTimeout(t, 200*time.Millisecond)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	// Accept and then say nothing at all — and stay open, so the client waits on
	// a live connection rather than an EOF.
	held := make(chan net.Conn, 1)
	go func() {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		held <- nc
	}()
	t.Cleanup(func() {
		select {
		case nc := <-held:
			nc.Close()
		default:
		}
	})

	addr := ln.Addr().String()
	u := mustURL(t, "sftp://u:pw@"+addr+"/")
	key := sftpSessionKey{cfg: sftpCfg, addr: addr, user: "u", urlPassword: "pw"}

	done := make(chan error, 1)
	start := time.Now()
	go func() {
		s, err := dialSFTPSession(ctx, key, u)
		if s != nil {
			s.close()
		}
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("dialing a peer that never speaks should fail, not succeed")
		}
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Errorf("dial took %v against a %v budget", elapsed, sftpDialTimeout)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("dialSFTPSession did not return within 5s against a %v dial budget — "+
			"the handshake is unbounded. ssh.ClientConfig.Timeout covers net.Dial only, "+
			"so the conn deadline is the only thing that can interrupt ssh.NewClientConn",
			sftpDialTimeout)
	}
}

// Host-key policy is the other thing only dialSFTPSession runs, and its SAFE
// default is the one that must never quietly become a no-op: with sftp.insecure
// unset, a server whose key is in no known_hosts must be refused. Nothing could
// observe this before — the pipe sessions every other test uses are handed an
// already-established transport and have no host key at all.
func TestSFTPDialRejectsAnUnknownHostKey(t *testing.T) {
	kh := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(kh, nil, 0o600); err != nil { // well-formed, and lists nobody
		t.Fatal(err)
	}
	withSFTPCfg(t, SFTPConfig{KnownHostsFile: kh}) // Insecure deliberately false
	t.Setenv("HOME", t.TempDir())
	withDialTimeout(t, 2*time.Second)

	addr := newSSHSFTPServer(t, "pw")
	u := mustURL(t, "sftp://u:pw@"+addr+"/")
	key := sftpSessionKey{cfg: sftpCfg, addr: addr, user: "u", urlPassword: "pw"}

	s, err := dialSFTPSession(ctx, key, u)
	if err == nil {
		s.close()
		t.Fatal("dialed a server whose host key appears in no known_hosts file — " +
			"the default host-key policy is not reaching the handshake")
	}
	if !strings.Contains(err.Error(), "handshake") {
		t.Errorf("err = %v, want the SSH handshake to be what refused it", err)
	}
}

// --- the probe's third state ------------------------------------------------

// healthName spells a sessionHealth out in a failure message. The whole point
// of this arm is which of three states it is, and "probe = 1" says nothing.
func healthName(h sessionHealth) string {
	switch h {
	case sessionHealthy:
		return "sessionHealthy"
	case sessionDead:
		return "sessionDead"
	case sessionUnresponsive:
		return "sessionUnresponsive"
	}
	return "sessionHealth(?)"
}

// newStuckSFTPClient returns a real *sftp.Client whose peer completed the
// protocol handshake and then went quiet: every request after it is read and
// never answered. That is the black-holed-peer shape — a NAT that dropped the
// mapping without sending an RST — and it is the only thing that reaches
// probe's timer arm. closed fires if and ONLY if something closes the client,
// and it fires before that Close returns, so the assertion needs no settle.
func newStuckSFTPClient(t *testing.T) (*sftp.Client, <-chan struct{}) {
	t.Helper()
	cr, sw := io.Pipe() // client reads ← server writes
	sr, cw := io.Pipe() // server reads ← client writes

	closed := make(chan struct{})
	go func() {
		defer sw.Close()
		defer close(closed) // LIFO: signalled before the client's recv loop can exit
		// SSH_FXP_INIT: a uint32 length, then the payload.
		var hdr [4]byte
		if _, err := io.ReadFull(sr, hdr[:]); err != nil {
			return
		}
		if _, err := io.CopyN(io.Discard, sr, int64(binary.BigEndian.Uint32(hdr[:]))); err != nil {
			return
		}
		// SSH_FXP_VERSION(3), no extensions — the last thing this peer ever says.
		if _, err := sw.Write([]byte{0, 0, 0, 5, 2, 0, 0, 0, 3}); err != nil {
			return
		}
		// Drain forever, so the client's writes never block, and answer nothing.
		_, _ = io.Copy(io.Discard, sr)
	}()

	client, err := sftp.NewClientPipe(cr, cw)
	if err != nil {
		t.Fatalf("sftp.NewClientPipe: %v", err)
	}
	t.Cleanup(func() { cw.Close(); cr.Close() })
	return client, closed
}

// probe answers in three states, and the third had no test at all: the timer
// never fires inside a unit test at the production 10s budget. The distinction
// is load-bearing — sessionUnresponsive means "replace it, do NOT close it",
// because a peer that is merely slow still has other goroutines' transfers
// multiplexed over that same SSH channel, and closing it loses them. Collapsing
// the arm into sessionDead would be invisible to every other test in this file.
func TestSFTPProbeUnresponsivePeerIsNotDead(t *testing.T) {
	withProbeTimeout(t, 100*time.Millisecond)
	stuck, closed := newStuckSFTPClient(t)
	s := &sftpSession{client: stuck}

	if got := s.probe(false); got != sessionUnresponsive {
		t.Fatalf("probe = %s, want sessionUnresponsive — a peer that accepts and never answers "+
			"is not a corpse, and calling it dead tears down transfers that are still live",
			healthName(got))
	}

	// ...and the memo must act on the distinction: replace, but leave it open.
	c := withSFTPSessionMemo(t)
	key := sftpSessionKey{addr: "stuck:22", user: "alice"}
	e := sftpEntryFor(key)
	e.mu.Lock()
	e.sess = s
	e.mu.Unlock()

	fresh, err := sftpSessionFor(ctx, key, mustURL(t, "sftp://alice@stuck/p"))
	if err != nil {
		t.Fatalf("sftpSessionFor: %v", err)
	}
	if fresh == s {
		t.Error("the unresponsive session was handed back out; it must be replaced")
	}
	if c.dials != 1 {
		t.Errorf("dials = %d, want 1 (the replacement)", c.dials)
	}
	select {
	case <-closed:
		t.Error("the unresponsive session was CLOSED. Not answering in time is not proof of " +
			"death, and the conn is shared: closing it kills the transfers still in flight on it")
	default:
	}
}
