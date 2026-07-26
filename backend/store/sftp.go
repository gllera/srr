package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

var sftpCfg SFTPConfig

type SFTPConfig struct {
	User           string `yaml:"user"`
	Password       string `yaml:"password" secret:"true"`
	PrivateKey     string `yaml:"private-key"`
	KnownHostsFile string `yaml:"known-hosts-file"`
	Insecure       bool   `yaml:"insecure"`
}

func init() {
	Register("sftp", newSFTP)
	RegisterConfig("sftp", &sftpCfg)
}

// SFTP is a handle onto a store path. It owns no connection: the SSH session
// and the SFTP subsystem riding it belong to the sftpSessions memo below, and
// several handles share one concurrently (pkg/sftp multiplexes requests over the
// single channel and its Client is safe for concurrent use).
//
// It remembers the session's IDENTITY (key/u) as well as the session itself,
// because a handle outlives connections: a fetch cycle opens the store once and
// runs for minutes, so when the peer goes away mid-cycle the handle must be able
// to go back to the memo for a redialed session (see conn/reconnect) instead of
// failing every remaining op against a corpse.
type SFTP struct {
	path string
	host string
	key  sftpSessionKey
	u    *url.URL // nil for a handle built outside the memo (tests): no redial

	// mu guards sess alone. The handle is shared across a fetch's asset
	// workers, so the redial swap must not race their reads of it.
	mu   sync.Mutex
	sess *sftpSession
}

// sftpSession is one dialed SSH connection plus the SFTP subsystem on it.
// conn is the raw transport, kept ONLY so alive() can put a deadline on its
// probe; it is nil for a session built over an already-established transport
// (the tests' in-process pipe), which then probes undeadlined.
type sftpSession struct {
	client    *sftp.Client
	sshClient *ssh.Client
	conn      net.Conn
}

// sftpProbeTimeout bounds the liveness probe. A black-holed peer — a NAT that
// evicted the mapping without sending an RST is the ordinary cause — answers
// nothing and closes nothing, so an undeadlined Getwd waits out the kernel's
// full TCP retransmit schedule (minutes). The probe stands in for a dial, so
// anything longer than a dial's own budget is the wrong trade.
const sftpProbeTimeout = 10 * time.Second

// sftpDialTimeout bounds the whole connect — TCP, SSH handshake AND subsystem
// open. ssh.ClientConfig.Timeout covers only the net.Dial, so relying on it
// left the handshake and sftp.NewClient unbounded; dialSFTPSession therefore
// drives the sequence itself with a deadline on the conn.
const sftpDialTimeout = 30 * time.Second

// close tears the session down for real. ONLY the memo calls it, and only for a
// session a liveness probe has just found dead — see sftpSessions for who owns
// teardown now. sshClient is nil for a session built over an already-established
// transport (the tests' in-process pipe), which has no ssh connection to close.
// Close errors are dropped on purpose: a corpse has nothing left to report.
func (s *sftpSession) close() {
	s.client.Close()
	if s.sshClient != nil {
		s.sshClient.Close()
	}
}

// alive reports whether the server still answers, with one cheap round trip
// (SSH_FXP_REALPATH of "."). A memoized session outlives the handle that dialed
// it, so the next lookup must ASK rather than assume: a server restart, an idle
// disconnect or a NAT eviction leaves a Client whose every op fails. One round
// trip is nothing against the TCP connect + SSH handshake + subsystem open it
// stands in for.
//
// It catches a session that died BETWEEN two Opens; one that dies mid-op is
// caught by the same probe from the other side, via sftpSessionRefresh. Either
// way the replacement is possible only because a session's identity is its key
// and nothing holds a reference the memo cannot replace.
//
// The probe is DEADLINED (sftpProbeTimeout). A deadline on the conn is the
// right instrument rather than racing the call against a timer: a timed-out
// goroutine would stay parked on the dead socket for the full retransmit
// window, holding the entry lock it was supposed to release. A deadline hit
// reads as "not alive", so the corpse is dropped and redialed — which is the
// correct answer for a peer that cannot answer a one-round-trip question.
func (s *sftpSession) alive() bool {
	if s.conn != nil {
		_ = s.conn.SetDeadline(time.Now().Add(sftpProbeTimeout))
		defer func() { _ = s.conn.SetDeadline(time.Time{}) }()
	}
	_, err := s.client.Getwd()
	return err == nil
}

// sftpSessionKey is a session's IDENTITY: everything that decides which server
// this is and who we are to it. The resolved SFTPConfig carries the credentials
// and the host-key policy, addr the dialed endpoint, user the login, and
// urlPassword the one credential that rides the store URL rather than the config
// (sftpAuthMethods prefers it over SFTPConfig.Password). Two stores differing in
// ANY of those must never share a session, which is what makes this a composite
// key rather than the bare address it looks like it could be.
type sftpSessionKey struct {
	cfg         SFTPConfig
	addr        string
	user        string
	urlPassword string
}

// sftpSessions memoizes dialed sessions per identity — s3.go's s3ClientFor
// pattern applied to a protocol whose setup costs far more: newSFTP used to pay
// a TCP connect, an SSH handshake and a subsystem open on EVERY store.Open, i.e.
// once per serve API request and once per fetch cycle.
//
// The memo OWNS every session in it. A handle's Close releases the handle and
// nothing else (see SFTP.Close); teardown happens here, and only when a lookup
// finds a session dead and replaces it. Sessions therefore live for the process,
// which is the point — and the process exit that reclaims them is the same event
// that used to. The map holds one entry per distinct store identity, which in
// every real deployment is one.
//
// The map holds ENTRIES, not sessions: the process-global mutex below guards
// map access alone, and each entry's own mutex guards that identity's probe and
// dial. Peer I/O under a process-global lock is what this shape exists to
// prevent — see sftpSessionFor.

// An entry is one identity's slot.
type sftpEntry struct {
	mu   sync.Mutex
	sess *sftpSession
}

var (
	// sftpSessionsMu guards the MAP only. Never hold it across peer I/O.
	sftpSessionsMu sync.Mutex
	sftpSessions   = map[sftpSessionKey]*sftpEntry{}
)

// sftpDialSession is the dialer, a var so the memo tests can substitute
// in-process pipe sessions and count dials without standing up an ssh server.
var sftpDialSession = dialSFTPSession

// sftpEntryFor returns key's slot, creating an empty one on first sight. The
// process-global lock is held for this map operation ALONE — never across the
// probe or the dial below.
func sftpEntryFor(key sftpSessionKey) *sftpEntry {
	sftpSessionsMu.Lock()
	defer sftpSessionsMu.Unlock()
	e, ok := sftpSessions[key]
	if !ok {
		e = &sftpEntry{}
		sftpSessions[key] = e
	}
	return e
}

// sftpSessionFor returns the memoized session for key, dialing when there is
// none or when the memoized one no longer answers.
//
// The ENTRY's lock spans the probe and the dial deliberately: a burst of
// concurrent Opens against a cold memo then performs ONE handshake and shares
// it instead of N. The cost is that an unreachable server stalls every waiting
// Open for THAT identity for the dial timeout rather than only the first — the
// same trade s3ClientFor makes, and the right one when the alternative is N
// simultaneous handshakes into a server that is already struggling.
//
// What the entry lock buys over the map lock it replaced is containment: a peer
// that accepts the connection and then answers nothing used to park the first
// caller inside the process-global critical section, queueing every store.Open
// and every redial in the process behind it — including ones for entirely
// different backends — un-interruptible by SIGTERM. Now a wedged identity
// stalls only the goroutines that want that identity, and the probe and dial it
// stalls in are themselves deadline-bounded.
func sftpSessionFor(ctx context.Context, key sftpSessionKey, u *url.URL) (*sftpSession, error) {
	e := sftpEntryFor(key)
	e.mu.Lock()
	defer e.mu.Unlock()

	if s := e.sess; s != nil {
		if s.alive() {
			return s, nil
		}
		// Drop the corpse BEFORE dialing, so a failed dial cannot leave it behind
		// for the next lookup to probe all over again.
		e.sess = nil
		s.close()
	}

	s, err := sftpDialSession(ctx, key, u)
	if err != nil {
		return nil, err
	}
	e.sess = s
	return s, nil
}

// sftpSessionRefresh replaces a session a LIVE OPERATION just found broken —
// the mid-op half of sftpSessionFor's between-Opens probe.
//
// The caller saw a connection-class error on dead, which is a suspicion and not
// a verdict: a per-request failure can look like a disconnect, and the session
// is shared, so tearing it down on one op's say-so would break every other
// handle using it. So the corpse is confirmed the same way a stale memo entry
// is (one probe) and dropped only while it is STILL the memoized session —
// another goroutine racing the same reset may already have replaced it, and
// dropping its healthy replacement would start an endless redial loop.
func sftpSessionRefresh(ctx context.Context, key sftpSessionKey, u *url.URL, dead *sftpSession) (*sftpSession, error) {
	if u == nil {
		// A handle built outside the memo (the pipe-session tests) has no
		// identity to redial to; its session is whatever it was handed.
		return dead, nil
	}

	e := sftpEntryFor(key)
	e.mu.Lock()
	if e.sess == dead && dead != nil && !dead.alive() {
		e.sess = nil
		dead.close()
	}
	e.mu.Unlock()

	// Outside the entry lock deliberately: sftpSessionFor takes it itself, and it
	// is the single place that dials — a fresh session another goroutine
	// installed meanwhile is simply returned.
	return sftpSessionFor(ctx, key, u)
}

// dialSFTPSession performs the full connect: auth resolution, host-key policy,
// SSH handshake, subsystem open. It runs only on a memo miss, which is why the
// auth chain (reading ~/.ssh keys, dialing the agent socket) lives in here
// rather than in newSFTP.
func dialSFTPSession(ctx context.Context, key sftpSessionKey, u *url.URL) (_ *sftpSession, retErr error) {
	auth, cleanup, err := sftpAuthMethods(u)
	if err != nil {
		return nil, err
	}
	// The ssh-agent socket (if any) is only needed for the handshake below.
	defer cleanup()

	hostKeyCallback, err := sftpHostKeyCallback()
	if err != nil {
		return nil, fmt.Errorf("loading known hosts: %w", err)
	}

	// Driven step by step rather than through ssh.Dial because that helper's
	// ClientConfig.Timeout bounds the net.Dial ALONE: the SSH handshake and the
	// subsystem open that follow it are unbounded, so a peer that completes a TCP
	// connect and then goes quiet hangs here forever. One deadline on the conn
	// covers all three, and is cleared before the session is handed out (an
	// absolute deadline left in place would later kill live transfers).
	conn, err := (&net.Dialer{Timeout: sftpDialTimeout}).DialContext(ctx, "tcp", key.addr)
	if err != nil {
		return nil, fmt.Errorf("dial sftp server %s: %w", key.addr, err)
	}
	defer func() {
		if retErr != nil {
			conn.Close()
		}
	}()
	if err := conn.SetDeadline(time.Now().Add(sftpDialTimeout)); err != nil {
		return nil, fmt.Errorf("dial sftp server %s: %w", key.addr, err)
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(conn, key.addr, &ssh.ClientConfig{
		User:            key.user,
		Auth:            auth,
		HostKeyCallback: hostKeyCallback,
		Timeout:         sftpDialTimeout,
	})
	if err != nil {
		return nil, fmt.Errorf("sftp handshake with %s: %w", key.addr, err)
	}
	sshClient := ssh.NewClient(sshConn, chans, reqs)
	defer func() {
		if retErr != nil {
			sshClient.Close()
		}
	}()

	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, fmt.Errorf("create sftp client: %w", err)
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, fmt.Errorf("clearing dial deadline for %s: %w", key.addr, err)
	}
	return &sftpSession{client: client, sshClient: sshClient, conn: conn}, nil
}

func sftpHostKeyCallback() (ssh.HostKeyCallback, error) {
	if sftpCfg.Insecure {
		// The sftp.insecure opt-in, the SSH sibling of http.insecure: the operator
		// has said not to verify the host key. Audited and deliberate — this branch
		// exists for no other reason.
		//nolint:gosec // G106: opt-in sftp.insecure
		return ssh.InsecureIgnoreHostKey(), nil
	}

	khFile := sftpCfg.KnownHostsFile
	if khFile == "" {
		home, _ := os.UserHomeDir()
		khFile = filepath.Join(home, ".ssh", "known_hosts")
	}

	return knownhosts.New(khFile)
}

func newSFTP(ctx context.Context, u *url.URL) (Backend, error) {
	addr := u.Host
	if u.Port() == "" {
		addr = net.JoinHostPort(u.Hostname(), "22")
	}
	urlPassword := ""
	if u.User != nil {
		urlPassword, _ = u.User.Password()
	}

	key := sftpSessionKey{
		cfg:         sftpCfg,
		addr:        addr,
		user:        sftpUser(u),
		urlPassword: urlPassword,
	}
	sess, err := sftpSessionFor(ctx, key, u)
	if err != nil {
		return nil, err
	}

	basePath := strings.TrimRight(u.Path, "/")
	if basePath == "" && strings.HasPrefix(u.Path, "/") {
		basePath = "/"
	}

	if basePath != "" && basePath != "/" {
		// A bad base path fails this Open but does NOT touch the session: it is
		// the memo's, it may already be serving other handles, and a missing
		// directory says nothing about the connection.
		info, err := sess.client.Stat(basePath)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, fmt.Errorf("sftp base path %q does not exist", basePath)
			}
			return nil, fmt.Errorf("checking sftp base path %q: %w", basePath, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("sftp base path %q is not a directory", basePath)
		}
	}

	return &SFTP{
		path: basePath,
		host: addr,
		key:  key,
		u:    u,
		sess: sess,
	}, nil
}

// conn returns the client this handle is currently bound to.
func (d *SFTP) conn() *sftp.Client {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sess.client
}

// reconnect goes back to the memo after a connection-class failure and adopts
// whatever session it hands back — the same one when the peer turns out to be
// alive, a redialed one when it is not.
func (d *SFTP) reconnect(ctx context.Context) (*sftp.Client, error) {
	d.mu.Lock()
	dead := d.sess
	d.mu.Unlock()

	fresh, err := sftpSessionRefresh(ctx, d.key, d.u, dead)
	if err != nil {
		return nil, err
	}

	d.mu.Lock()
	d.sess = fresh
	d.mu.Unlock()
	return fresh.client, nil
}

// clientFor resolves the client for one attempt: the bound session on the first,
// a re-resolved (possibly redialed) one on every retry — retryLoop only comes
// back here after a connection-class failure, which is exactly the event that
// makes the bound session suspect.
func (d *SFTP) clientFor(ctx context.Context, attempt int) (*sftp.Client, error) {
	if attempt == 1 {
		return d.conn(), nil
	}
	return d.reconnect(ctx)
}

// retry runs a body-less op under the store retry policy (see retry.go),
// handing it a freshly resolved client per attempt.
func (d *SFTP) retry(ctx context.Context, op func(*sftp.Client) error) error {
	return withRetry(ctx, func(attempt int) error {
		c, err := d.clientFor(ctx, attempt)
		if err != nil {
			return err
		}
		return op(c)
	})
}

// retryBody is retry for a write: the rewinder decides whether the body can be
// replayed at all, so a retried upload is either byte-complete or never made.
func (d *SFTP) retryBody(ctx context.Context, r io.Reader, op func(*sftp.Client, io.Reader) error) error {
	return withRetryBody(ctx, r, func(attempt int, body io.Reader) error {
		c, err := d.clientFor(ctx, attempt)
		if err != nil {
			return err
		}
		return op(c, body)
	})
}

func (d *SFTP) sftpPath(op, key string) string {
	full := path.Join(d.path, key)
	slog.Debug("db "+op, "url", "sftp://"+path.Join(d.host, full))
	return full
}

func (d *SFTP) ensureDir(c *sftp.Client, file string) error {
	dir := path.Dir(file)
	if dir == d.path || dir == "." || dir == "/" {
		return nil
	}
	if err := c.MkdirAll(dir); err != nil {
		return fmt.Errorf("creating directory %s: %w", dir, err)
	}
	return nil
}

func (d *SFTP) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	file := d.sftpPath("read", key)
	var rc io.ReadCloser
	err := d.retry(ctx, func(c *sftp.Client) error {
		fs, err := c.Open(file)
		if isNotExist(err) {
			return errMissing("opening file", file)
		}
		if err != nil {
			return fmt.Errorf("opening file %s: %w", file, err)
		}
		rc = fs
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Only OPENING the file is retried. The stream itself is the caller's, and a
	// failure part-way through it is theirs to see: we cannot re-deliver bytes
	// they have already consumed.
	return rc, nil
}

func (d *SFTP) Put(ctx context.Context, key string, r io.Reader, ignoreExisting bool) error {
	file := d.sftpPath("write", key)
	write := func(c *sftp.Client, body io.Reader) error {
		if err := d.ensureDir(c, file); err != nil {
			return err
		}

		fs, err := c.OpenFile(file, writeOpenFlags(ignoreExisting))
		if err != nil {
			// pkg/sftp maps EEXIST to the generic SSH_FX_FAILURE (SFTPv3 has no
			// dedicated "already exists" status), so the raw error doesn't satisfy
			// errors.Is(_, os.ErrExist) the way S3/HTTP/local do. On an exclusive
			// create, re-stat: if the target now exists it was a conflict, so surface
			// the store-lock 409 sentinel instead of a raw failure.
			if !ignoreExisting {
				if _, statErr := c.Stat(file); statErr == nil {
					return fmt.Errorf("key %q already exists: %w", file, os.ErrExist)
				}
			}
			return fmt.Errorf("opening file %s: %w", file, err)
		}

		if _, err := io.Copy(fs, body); err != nil {
			fs.Close()
			return fmt.Errorf("writing file %s: %w", file, err)
		}
		if err := fs.Close(); err != nil {
			return fmt.Errorf("closing file %s: %w", file, err)
		}
		return nil
	}

	if !ignoreExisting {
		// An exclusive create is NEVER retried. This is the `.locked` lease
		// acquire: a repeat after a create that landed before the connection
		// broke would find the marker THIS process just wrote, report os.ErrExist
		// against itself, and wedge the writer until a human passes --force.
		return write(d.conn(), r)
	}
	return d.retryBody(ctx, r, write)
}

// Version digests the file's bytes, for the reasons Local.Version states — an
// SFTP server exposes no entity tag either, and its clock is not this host's.
func (d *SFTP) Version(ctx context.Context, key string) (string, error) {
	file := d.sftpPath("version", key)
	var version string
	err := d.retry(ctx, func(c *sftp.Client) error {
		fs, err := c.Open(file)
		if os.IsNotExist(err) {
			version = ""
			return nil
		}
		if err != nil {
			return fmt.Errorf("opening file %s: %w", file, err)
		}
		defer fs.Close()
		h := sha256.New()
		if _, err := io.Copy(h, fs); err != nil {
			return fmt.Errorf("reading file %s: %w", file, err)
		}
		version = hex.EncodeToString(h.Sum(nil))
		return nil
	})
	if err != nil {
		return "", err
	}
	return version, nil
}

// PutIfVersion is best-effort, exactly as Local.PutIfVersion is and with the
// same justification: check, then rename.
func (d *SFTP) PutIfVersion(ctx context.Context, key string, r io.Reader, meta ObjectMeta, want string) (string, error) {
	cur, err := d.Version(ctx, key)
	if err != nil {
		return "", err
	}
	if cur != want {
		return "", fmt.Errorf("%s: %w", d.sftpPath("conditional write", key), ErrPreconditionFailed)
	}
	h := sha256.New()
	if err := d.AtomicPut(ctx, key, io.TeeReader(r, h), meta); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// AtomicPut ignores meta: SFTP files have no stored Content-Type/-Encoding —
// the static server stamps response headers by extension at request time.
func (d *SFTP) AtomicPut(ctx context.Context, key string, r io.Reader, _ ObjectMeta) error {
	file := d.sftpPath("atomic write", key)
	// Retried as a whole: every attempt draws its OWN uniqueTempName and removes
	// it on the way out, so a repeat can neither collide with nor inherit the
	// staging file of the attempt that lost its connection.
	return d.retryBody(ctx, r, func(c *sftp.Client, body io.Reader) error {
		if err := d.ensureDir(c, file); err != nil {
			return err
		}
		tmpFile := uniqueTempName(file)

		fs, err := c.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
		if err != nil {
			return fmt.Errorf("opening file %s: %w", tmpFile, err)
		}
		// Sweep AFTER creating our own staging file, so the sweep can read the
		// server's clock off it. See sweepTempLeftovers.
		d.sweepTempLeftovers(c, path.Dir(file), path.Base(tmpFile))

		if _, err := io.Copy(fs, body); err != nil {
			fs.Close()
			_ = c.Remove(tmpFile)
			return fmt.Errorf("writing file %s: %w", tmpFile, err)
		}
		// fsync before the rename, like the Local backend: a crash must not publish
		// truncated bytes under a name that is immutable and cached forever. Sync
		// needs the fsync@openssh.com extension, so a server without it fails here —
		// best-effort by design, since making it fatal would break every write to
		// such a server for a durability guarantee it simply cannot offer.
		if err := fs.Sync(); err != nil {
			slog.Debug("sftp fsync unavailable, writing without it", "file", tmpFile, "err", err)
		}
		if err := fs.Close(); err != nil {
			_ = c.Remove(tmpFile)
			return fmt.Errorf("closing file %s: %w", tmpFile, err)
		}

		if err := c.PosixRename(tmpFile, file); err != nil {
			_ = c.Remove(tmpFile)
			return fmt.Errorf("renaming %s to %s: %w", tmpFile, file, err)
		}
		return nil
	})
}

// sweepTempLeftovers is the Local backend's sweep over SFTP: it removes
// uniqueTempName staging files a hard-killed predecessor stranded in dir
// (rename never ran; the unique names mean nothing overwrites them and no GC
// speaks them), age-gated by staleTemp. ownTemp names the caller's own staging
// file, just created in dir, and its mtime in THIS listing is the reference
// "now" — the server's clock, read without an extra round-trip, so the gate
// never compares a remote mtime against this host's clock. Best-effort and
// silent on errors — janitor work must never fail the AtomicPut that
// triggered it.
func (d *SFTP) sweepTempLeftovers(c *sftp.Client, dir, ownTemp string) {
	entries, err := c.ReadDir(dir)
	if err != nil {
		return
	}
	var now time.Time
	for _, fi := range entries {
		if fi.Name() == ownTemp {
			now = fi.ModTime()
			break
		}
	}
	if now.IsZero() {
		return
	}
	for _, fi := range entries {
		if fi.Name() == ownTemp || !fi.Mode().IsRegular() || !isTempLeftover(fi.Name()) || !staleTemp(fi.ModTime(), now) {
			continue
		}
		file := path.Join(dir, fi.Name())
		if err := c.Remove(file); err == nil {
			slog.Info("removed stale atomic-write leftover", "file", file)
		}
	}
}

// Stat returns the remote file's size. A missing key is an error wrapping
// fs.ErrNotExist per the Backend contract; a nil error therefore PROVES the
// file exists, zero-byte included.
func (d *SFTP) Stat(ctx context.Context, key string) (int64, error) {
	file := d.sftpPath("stat", key)
	var size int64
	err := d.retry(ctx, func(c *sftp.Client) error {
		fi, err := c.Stat(file)
		if isNotExist(err) {
			slog.Debug("db not found", "key", file)
			return errMissing("stat file", file)
		}
		if err != nil {
			return fmt.Errorf("stat file %s: %w", file, err)
		}
		size = fi.Size()
		return nil
	})
	if err != nil {
		return 0, err
	}
	return size, nil
}

func (d *SFTP) Rm(ctx context.Context, key string) error {
	file := d.sftpPath("delete", key)
	return d.retry(ctx, func(c *sftp.Client) error {
		return rmErr(c.Remove(file), file)
	})
}

// List walks the prefix's directory over SFTP, mirroring Local.List exactly:
// regular files only, a prefix naming no directory is an empty set with a nil
// error, an entry that vanished mid-walk is skipped, and the result is sorted
// into the contract's lexicographic order.
func (d *SFTP) List(ctx context.Context, prefix string) ([]string, error) {
	root := path.Join(d.path, listDir(prefix))
	slog.Debug("db list", "url", "sftp://"+path.Join(d.host, root), "prefix", prefix)

	var out []string
	err := d.retry(ctx, func(c *sftp.Client) error {
		// A retry re-walks from scratch: the partial result of a walk the
		// connection cut short is never carried over.
		out = nil
		w := c.Walk(root)
		for w.Step() {
			if err := w.Err(); err != nil {
				if isNotExist(err) {
					continue
				}
				return fmt.Errorf("listing %s: %w", root, err)
			}
			if !w.Stat().Mode().IsRegular() {
				continue
			}
			// The walker reports server-absolute paths under d.path; strip the base
			// (and any separator it leaves) to get back to a store-relative key.
			key := strings.TrimPrefix(strings.TrimPrefix(w.Path(), d.path), "/")
			if strings.HasPrefix(key, prefix) {
				out = append(out, key)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.Sort(out)
	return out, nil
}

// Close releases this handle and tears NOTHING down. The session it used
// belongs to the sftpSessions memo, is shared with every other handle on the
// same identity, and deliberately outlives all of them — closing it here is
// exactly what made every store.Open pay a fresh TCP connect + SSH handshake +
// subsystem open, i.e. one per serve API request. The memo closes a session when
// a later lookup finds it dead (sftpSession.alive); process exit closes the rest.
func (d *SFTP) Close() error { return nil }

func sftpUser(u *url.URL) string {
	if u.User != nil && u.User.Username() != "" {
		return u.User.Username()
	}
	if sftpCfg.User != "" {
		return sftpCfg.User
	}
	if user := os.Getenv("USER"); user != "" {
		return user
	}
	return "root"
}

// sftpAuthMethods returns the auth methods plus a cleanup func the caller must
// invoke once the SSH handshake is done. The ssh-agent Unix socket is only
// needed during auth, but it must stay open across the handshake; returning a closer
// (instead of closing it here) prevents the fd leak of the never-closed socket.
func sftpAuthMethods(u *url.URL) ([]ssh.AuthMethod, func(), error) {
	var methods []ssh.AuthMethod
	cleanup := func() {}

	// Password precedence: URL password → config password. Decoupled from whether
	// the URL carries a username — the common sftp://user@host form (username, no
	// URL password) must still fall back to the configured password instead of
	// silently offering no password method at all.
	urlPw, hasURLPw := "", false
	if u.User != nil {
		urlPw, hasURLPw = u.User.Password()
	}
	if hasURLPw {
		methods = append(methods, ssh.Password(urlPw))
	} else if sftpCfg.Password != "" {
		methods = append(methods, ssh.Password(sftpCfg.Password))
	}

	if sftpCfg.PrivateKey != "" {
		pem, err := os.ReadFile(sftpCfg.PrivateKey)
		if err != nil {
			return nil, cleanup, fmt.Errorf("reading private key %s: %w", sftpCfg.PrivateKey, err)
		}
		key, err := ssh.ParsePrivateKey(pem)
		if err != nil {
			return nil, cleanup, fmt.Errorf("parsing private key %s: %w", sftpCfg.PrivateKey, err)
		}
		methods = append(methods, ssh.PublicKeys(key))
	} else {
		home, _ := os.UserHomeDir()
		for _, name := range []string{"id_rsa", "id_ed25519", "id_ecdsa", "id_ecdsa_sk", "id_ed25519_sk"} {
			pem, err := os.ReadFile(filepath.Join(home, ".ssh", name))
			if err != nil {
				continue
			}
			if key, err := ssh.ParsePrivateKey(pem); err == nil {
				methods = append(methods, ssh.PublicKeys(key))
				break
			}
		}
	}

	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		// A connect to a local AF_UNIX socket completes or fails immediately —
		// there is no blocking phase for a context to cancel. The dial that CAN
		// hang is the connect in dialSFTPSession, a remote TCP handshake bounded
		// by sftpDialTimeout, and noctx does not recognise it; honouring the linter here
		// while the real network call next door stays context-less would be
		// ceremony, and it would mean threading a ctx through sftpAuthMethods that
		// newSFTP deliberately discards.
		// G704 reads $SSH_AUTH_SOCK as tainted input reaching a dial and calls it
		// SSRF. It is the ssh-agent protocol: that variable is how every SSH client
		// finds the agent, the network is an AF_UNIX socket on this machine, and
		// the only thing sent is a signature request.
		//nolint:noctx,gosec // local unix socket; nothing to cancel, and G704 is not SSRF
		if agentConn, err := net.Dial("unix", sock); err == nil {
			methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(agentConn).Signers))
			cleanup = func() { agentConn.Close() }
		}
	}

	if len(methods) == 0 {
		return nil, cleanup, fmt.Errorf("no password, private key, or ssh-agent key available for sftp auth")
	}

	return methods, cleanup, nil
}
