package store

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

var sftpCfg SFTPConfig

type SFTPConfig struct {
	User           string `yaml:"user"`
	Password       string `yaml:"password"`
	PrivateKey     string `yaml:"private-key"`
	KnownHostsFile string `yaml:"known-hosts-file"`
	Insecure       bool   `yaml:"insecure"`
}

func init() {
	Register("sftp", newSFTP)
	RegisterConfig("sftp", &sftpCfg)
}

type SFTP struct {
	path      string
	host      string
	client    *sftp.Client
	sshClient *ssh.Client
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

func newSFTP(_ context.Context, u *url.URL) (_ Backend, retErr error) {
	auth, err := sftpAuthMethods(u)
	if err != nil {
		return nil, err
	}

	hostKeyCallback, err := sftpHostKeyCallback()
	if err != nil {
		return nil, fmt.Errorf("loading known hosts: %w", err)
	}

	addr := u.Host
	if u.Port() == "" {
		addr = net.JoinHostPort(u.Hostname(), "22")
	}

	sshClient, err := ssh.Dial("tcp", addr, &ssh.ClientConfig{
		User:            sftpUser(u),
		Auth:            auth,
		HostKeyCallback: hostKeyCallback,
		Timeout:         30 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("dial sftp server %s: %w", addr, err)
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
	defer func() {
		if retErr != nil {
			client.Close()
		}
	}()

	basePath := strings.TrimRight(u.Path, "/")
	if basePath == "" && strings.HasPrefix(u.Path, "/") {
		basePath = "/"
	}

	if basePath != "" && basePath != "/" {
		info, err := client.Stat(basePath)
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
		path:      basePath,
		host:      addr,
		client:    client,
		sshClient: sshClient,
	}, nil
}

func (d *SFTP) sftpPath(op, key string) string {
	full := path.Join(d.path, key)
	slog.Debug("db "+op, "url", "sftp://"+path.Join(d.host, full))
	return full
}

func (d *SFTP) Get(_ context.Context, key string, ignoreMissing bool) (io.ReadCloser, error) {
	file := d.sftpPath("read", key)
	fs, err := d.client.Open(file)
	if os.IsNotExist(err) && ignoreMissing {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("opening file %s: %w", file, err)
	}
	return fs, nil
}

func (d *SFTP) Put(_ context.Context, key string, r io.Reader, ignoreExisting bool) error {
	file := d.sftpPath("write", key)

	fs, err := d.client.OpenFile(file, writeOpenFlags(ignoreExisting))
	if err != nil {
		return fmt.Errorf("opening file %s: %w", file, err)
	}
	defer fs.Close()

	if _, err := io.Copy(fs, r); err != nil {
		return fmt.Errorf("writing file %s: %w", file, err)
	}
	return nil
}

func (d *SFTP) AtomicPut(_ context.Context, key string, r io.Reader) error {
	file := d.sftpPath("atomic write", key)
	tmpFile := file + ".tmp"

	fs, err := d.client.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
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

	if err := d.client.PosixRename(tmpFile, file); err != nil {
		return fmt.Errorf("renaming %s to %s: %w", tmpFile, file, err)
	}
	return nil
}

func (d *SFTP) Rm(_ context.Context, key string) error {
	file := d.sftpPath("delete", key)
	if err := d.client.Remove(file); err != nil {
		if os.IsNotExist(err) {
			slog.Warn("db not found", "key", file)
		} else {
			return fmt.Errorf("removing %s: %w", file, err)
		}
	}
	return nil
}

func (d *SFTP) Close() error {
	d.client.Close()
	return d.sshClient.Close()
}

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

func sftpAuthMethods(u *url.URL) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod

	if u.User != nil {
		if pw, ok := u.User.Password(); ok {
			methods = append(methods, ssh.Password(pw))
		}
	} else if sftpCfg.Password != "" {
		methods = append(methods, ssh.Password(sftpCfg.Password))
	}

	if sftpCfg.PrivateKey != "" {
		pem, err := os.ReadFile(sftpCfg.PrivateKey)
		if err != nil {
			return nil, fmt.Errorf("reading private key %s: %w", sftpCfg.PrivateKey, err)
		}
		key, err := ssh.ParsePrivateKey(pem)
		if err != nil {
			return nil, fmt.Errorf("parsing private key %s: %w", sftpCfg.PrivateKey, err)
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
		if agentConn, err := net.Dial("unix", sock); err == nil {
			methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(agentConn).Signers))
		}
	}

	if len(methods) == 0 {
		return nil, fmt.Errorf("no password, private key, or ssh-agent key available for sftp auth")
	}

	return methods, nil
}
