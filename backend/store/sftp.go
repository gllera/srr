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
type SFTP struct {
	path   string
	host   string
	client *sftp.Client
}

// sftpSession is one dialed SSH connection plus the SFTP subsystem on it.
type sftpSession struct {
	client    *sftp.Client
	sshClient *ssh.Client
}

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
// It catches a session that died BETWEEN two Opens, not one that dies mid-op —
// that is S67's redial, which will invalidate this memo entry on a
// connection-class failure and come back through sftpSessionFor for a fresh
// dial, exactly as a failed probe does here. None of that retry logic is built
// yet; the seam is that a session's identity is its key and nothing else holds a
// reference the memo cannot replace.
func (s *sftpSession) alive() bool {
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
var (
	sftpSessionsMu sync.Mutex
	sftpSessions   = map[sftpSessionKey]*sftpSession{}
)

// sftpDialSession is the dialer, a var so the memo tests can substitute
// in-process pipe sessions and count dials without standing up an ssh server.
var sftpDialSession = dialSFTPSession

// sftpSessionFor returns the memoized session for key, dialing when there is
// none or when the memoized one no longer answers.
//
// The lock spans the dial deliberately: a burst of concurrent Opens against a
// cold memo then performs ONE handshake and shares it instead of N. The cost is
// that an unreachable server stalls every waiting Open for the dial timeout
// rather than only the first — the same trade s3ClientFor makes, and the right
// one when the alternative is N simultaneous handshakes into a server that is
// already struggling.
func sftpSessionFor(key sftpSessionKey, u *url.URL) (*sftpSession, error) {
	sftpSessionsMu.Lock()
	defer sftpSessionsMu.Unlock()

	if s, ok := sftpSessions[key]; ok {
		if s.alive() {
			return s, nil
		}
		// Drop the corpse BEFORE dialing, so a failed dial cannot leave it behind
		// for the next lookup to probe all over again.
		delete(sftpSessions, key)
		s.close()
	}

	s, err := sftpDialSession(key, u)
	if err != nil {
		return nil, err
	}
	sftpSessions[key] = s
	return s, nil
}

// dialSFTPSession performs the full connect: auth resolution, host-key policy,
// SSH handshake, subsystem open. It runs only on a memo miss, which is why the
// auth chain (reading ~/.ssh keys, dialing the agent socket) lives in here
// rather than in newSFTP.
func dialSFTPSession(key sftpSessionKey, u *url.URL) (_ *sftpSession, retErr error) {
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

	sshClient, err := ssh.Dial("tcp", key.addr, &ssh.ClientConfig{
		User:            key.user,
		Auth:            auth,
		HostKeyCallback: hostKeyCallback,
		Timeout:         30 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("dial sftp server %s: %w", key.addr, err)
	}
	defer func() {
		if retErr != nil {
			sshClient.Close()
		}
	}()

	client, err := sftp.NewClient(sshClient)
	if err != nil {
		return nil, fmt.Errorf("create sftp client: %w", err)
	}
	return &sftpSession{client: client, sshClient: sshClient}, nil
}

func sftpHostKeyCallback() (ssh.HostKeyCallback, error) {
	if sftpCfg.Insecure {
		return ssh.InsecureIgnoreHostKey(), nil
	}

	khFile := sftpCfg.KnownHostsFile
	if khFile == "" {
		home, _ := os.UserHomeDir()
		khFile = filepath.Join(home, ".ssh", "known_hosts")
	}

	return knownhosts.New(khFile)
}

func newSFTP(_ context.Context, u *url.URL) (Backend, error) {
	addr := u.Host
	if u.Port() == "" {
		addr = net.JoinHostPort(u.Hostname(), "22")
	}
	urlPassword := ""
	if u.User != nil {
		urlPassword, _ = u.User.Password()
	}

	sess, err := sftpSessionFor(sftpSessionKey{
		cfg:         sftpCfg,
		addr:        addr,
		user:        sftpUser(u),
		urlPassword: urlPassword,
	}, u)
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
		path:   basePath,
		host:   addr,
		client: sess.client,
	}, nil
}

func (d *SFTP) sftpPath(op, key string) string {
	full := path.Join(d.path, key)
	slog.Debug("db "+op, "url", "sftp://"+path.Join(d.host, full))
	return full
}

func (d *SFTP) ensureDir(file string) error {
	dir := path.Dir(file)
	if dir == d.path || dir == "." || dir == "/" {
		return nil
	}
	if err := d.client.MkdirAll(dir); err != nil {
		return fmt.Errorf("creating directory %s: %w", dir, err)
	}
	return nil
}

func (d *SFTP) Get(_ context.Context, key string) (io.ReadCloser, error) {
	file := d.sftpPath("read", key)
	fs, err := d.client.Open(file)
	if isNotExist(err) {
		return nil, errMissing("opening file", file)
	}
	if err != nil {
		return nil, fmt.Errorf("opening file %s: %w", file, err)
	}
	return fs, nil
}

func (d *SFTP) Put(_ context.Context, key string, r io.Reader, ignoreExisting bool) error {
	file := d.sftpPath("write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}

	fs, err := d.client.OpenFile(file, writeOpenFlags(ignoreExisting))
	if err != nil {
		// pkg/sftp maps EEXIST to the generic SSH_FX_FAILURE (SFTPv3 has no
		// dedicated "already exists" status), so the raw error doesn't satisfy
		// errors.Is(_, os.ErrExist) the way S3/HTTP/local do. On an exclusive
		// create, re-stat: if the target now exists it was a conflict, so surface
		// the store-lock 409 sentinel instead of a raw failure.
		if !ignoreExisting {
			if _, statErr := d.client.Stat(file); statErr == nil {
				return fmt.Errorf("key %q already exists: %w", file, os.ErrExist)
			}
		}
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

// Version digests the file's bytes, for the reasons Local.Version states — an
// SFTP server exposes no entity tag either, and its clock is not this host's.
func (d *SFTP) Version(_ context.Context, key string) (string, error) {
	file := d.sftpPath("version", key)
	fs, err := d.client.Open(file)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("opening file %s: %w", file, err)
	}
	defer fs.Close()
	h := sha256.New()
	if _, err := io.Copy(h, fs); err != nil {
		return "", fmt.Errorf("reading file %s: %w", file, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
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
func (d *SFTP) AtomicPut(_ context.Context, key string, r io.Reader, _ ObjectMeta) error {
	file := d.sftpPath("atomic write", key)
	if err := d.ensureDir(file); err != nil {
		return err
	}
	tmpFile := uniqueTempName(file)

	fs, err := d.client.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return fmt.Errorf("opening file %s: %w", tmpFile, err)
	}
	// Sweep AFTER creating our own staging file, so the sweep can read the
	// server's clock off it. See sweepTempLeftovers.
	d.sweepTempLeftovers(path.Dir(file), path.Base(tmpFile))

	if _, err := io.Copy(fs, r); err != nil {
		fs.Close()
		_ = d.client.Remove(tmpFile)
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
		_ = d.client.Remove(tmpFile)
		return fmt.Errorf("closing file %s: %w", tmpFile, err)
	}

	if err := d.client.PosixRename(tmpFile, file); err != nil {
		_ = d.client.Remove(tmpFile)
		return fmt.Errorf("renaming %s to %s: %w", tmpFile, file, err)
	}
	return nil
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
func (d *SFTP) sweepTempLeftovers(dir, ownTemp string) {
	entries, err := d.client.ReadDir(dir)
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
		if err := d.client.Remove(file); err == nil {
			slog.Info("removed stale atomic-write leftover", "file", file)
		}
	}
}

// Stat returns the remote file's size; a missing key is (0, nil) per the
// Backend contract.
func (d *SFTP) Stat(_ context.Context, key string) (int64, error) {
	file := d.sftpPath("stat", key)
	fi, err := d.client.Stat(file)
	if isNotExist(err) {
		slog.Debug("db not found", "key", file)
		return 0, errMissing("stat file", file)
	}
	if err != nil {
		return 0, fmt.Errorf("stat file %s: %w", file, err)
	}
	return fi.Size(), nil
}

func (d *SFTP) Rm(_ context.Context, key string) error {
	file := d.sftpPath("delete", key)
	return rmErr(d.client.Remove(file), file)
}

// List walks the prefix's directory over SFTP, mirroring Local.List exactly:
// regular files only, a prefix naming no directory is an empty set with a nil
// error, an entry that vanished mid-walk is skipped, and the result is sorted
// into the contract's lexicographic order.
func (d *SFTP) List(_ context.Context, prefix string) ([]string, error) {
	root := path.Join(d.path, listDir(prefix))
	slog.Debug("db list", "url", "sftp://"+path.Join(d.host, root), "prefix", prefix)

	var out []string
	w := d.client.Walk(root)
	for w.Step() {
		if err := w.Err(); err != nil {
			if isNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("listing %s: %w", root, err)
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
// needed during auth, but it must stay open across ssh.Dial; returning a closer
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
		// hang is ssh.Dial in newSFTP, a remote TCP handshake bounded by its own
		// 30s Timeout, and noctx does not recognise it; honouring the linter here
		// while the real network call next door stays context-less would be
		// ceremony, and it would mean threading a ctx through sftpAuthMethods that
		// newSFTP deliberately discards.
		//nolint:noctx // local unix socket; nothing to cancel
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
