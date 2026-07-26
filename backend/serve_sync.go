package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

// The first-party cross-device profile-sync endpoint (RDR18).
//
// The reader's sync layer (frontend/src/js/sync.ts) needs exactly one thing
// from a server: a URL that answers GET with the last-stored profile JSON (or
// 404 when nothing is stored yet) and PUT by storing the body verbatim. That is
// the whole contract — no versioning, no merge, no locking; the reader does the
// merging. Until now the operator had to stand up their own KV worker for it,
// which is real friction for a feature whose server side is thirty lines.
//
// WHERE THE BLOB LIVES: a plain file under --sync-dir, NOT the pack store.
// Three reasons, in order of weight:
//   - The profile is DEVICE state, not store state. It is deliberately not part
//     of the writer↔reader pack contract (no PackSeries row, no manifest entry,
//     no GC rule), and putting it in the store would invite exactly that
//     confusion the next time someone reads the name table.
//   - A store may be PUBLIC by explicit choice (docs/STORE-VISIBILITY.md — the
//     production one is). The blob is a reading history: which articles a person
//     read and which they saved. Publishing that as a side effect of enabling
//     sync would be a privacy regression the operator never asked for.
//   - `srr serve` is one process on one box, so a local file is already durable
//     enough, costs no store round-trip per request, and its temp+rename is
//     atomic without a distributed commit story.
//
// CONCURRENCY: last-writer-wins overwrite, and deliberately nothing more. Two
// devices PUTting at once means one blob lands on top of the other — which is
// precisely what sync.ts already tolerates and heals: every cycle PULLS before
// it pushes and merges what it finds, and its push fires whenever the endpoint
// is BEHIND (derived from the pulled blob, not from an in-memory flag), so a
// device whose state was overwritten republishes it on its next cycle. A
// compare-and-swap here would buy nothing the reader's self-heal does not
// already provide, and would need a token the reader has no field to carry.
//
// PLACEMENT: the routes are registered on the same mux as /api/* and /mcp and
// are therefore behind the same `hostGuard` — unconditional loopback Host, plus
// the Origin carve-out that only a browser-set `Sec-Fetch-Site: same-origin`
// satisfies. That is NOT weakened here, and it has a deployment consequence
// worth stating plainly: a browser reader served from a DIFFERENT origin than
// this endpoint is refused (its request is cross-site, by construction). The
// supported shape is one hostname routing the reader and /sync/ to their
// respective origins — e.g. a Cloudflare tunnel with a path rule for /sync/*
// pointing at serve's httpHostHeader-rewritten localhost:8088, the same trick
// admin-srr.llera.eu already uses — so the browser sees one origin. Non-browser
// clients send no Origin and only meet the Host check. See README → Profile sync.

// syncBlobDir is where the profile blobs are kept, resolved once by
// ServeCmd.Run from --sync-dir before the listener starts (the same
// process-wide-resolved-config shape as `globals`). Empty DISABLES the
// endpoint: the routes stay registered and answer 404 with a message, so an
// operator who turned it off (or whose box exposes no user config dir) gets a
// legible answer instead of the admin console's index.html.
var syncBlobDir string

// maxSyncBody caps a PUT. A profile blob is a seen map (one entry per feed), a
// saved-chron array and their per-key stamps — kilobytes on a real device. 1 MiB
// is far above any of it, and an unbounded PUT on an admin origin is a hole.
const maxSyncBody = 1 << 20

const msgSyncDisabled = "profile sync is disabled on this server (no --sync-dir)"

// syncNameRe bounds the {name} segment to something safe as a FILENAME. Go's
// ServeMux already confines {name} to a single path segment (no slashes), so
// this is defence in depth — but the leading-alnum requirement is load-bearing
// rather than decorative: a bare character class would happily admit "." and
// ".." (and dotfiles), which are the only names that could escape the dir.
var syncNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// defaultSyncDir is the --sync-dir default: $XDG_CONFIG_HOME/srr/sync (i.e.
// ~/.config/srr/sync), next to srr.yaml. Unlike defaultCacheDir there is NO
// temp-dir fallback: the cache is disposable and a worse location only costs
// re-downloads, while a profile blob is device state a reboot must not eat. A
// box with no resolvable user config dir gets "" — the endpoint then reports
// itself disabled instead of quietly storing reading history in /tmp.
func defaultSyncDir() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "srr", "sync")
	}
	return ""
}

// registerSync mounts the blob routes. Method-by-method for the same Go 1.22+
// ServeMux reason /mcp is: a bare "/sync/{name}" and the "GET /" UI wildcard are
// CONFLICTING patterns (neither is more specific in both dimensions) and panic
// at registration; with the method stated, "GET /sync/{name}" beats "GET /" on
// path specificity and "PUT /sync/{name}" overlaps nothing.
func registerSync(mux *http.ServeMux) {
	mux.HandleFunc("GET /sync/{name}", getSyncProfile)
	mux.HandleFunc("PUT /sync/{name}", putSyncProfile)
}

// syncBlobPath validates the request and returns the file backing it. It writes
// the rejection itself and reports false when the caller must stop.
func syncBlobPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	if syncBlobDir == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": msgSyncDisabled})
		return "", false
	}
	name := r.PathValue("name")
	if !syncNameRe.MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid profile name %q", name)})
		return "", false
	}
	return filepath.Join(syncBlobDir, name+".json"), true
}

func getSyncProfile(w http.ResponseWriter, r *http.Request) {
	path, ok := syncBlobPath(w, r)
	if !ok {
		return
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		// 404 is a CONTRACT value here, not a failure: sync.ts reads it as
		// "the endpoint holds nothing yet" and seeds it with its next push.
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no profile stored"})
		return
	}
	if err != nil {
		// A read failure on a file we own is OURS, not the caller's — hence 500
		// rather than writeErr's shared 400 default, which exists because the
		// older handlers cannot tell validation from infrastructure.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// The blob is mutable device state; nothing may serve a cached copy of it
	// (the reader already sends cache:"no-store", but the endpoint must say so
	// too — a proxy sits between them in every real deployment).
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

func putSyncProfile(w http.ResponseWriter, r *http.Request) {
	path, ok := syncBlobPath(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSyncBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge,
				map[string]string{"error": fmt.Sprintf("profile exceeds %d bytes", maxSyncBody)})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("read request body: %v", err)})
		return
	}
	// Validate it is a JSON OBJECT, and store the bytes VERBATIM. Decoding into
	// raw messages proves well-formedness plus object-ness in one pass without
	// knowing (or pinning) the profile schema — which is the reader's, not this
	// server's, and gains additive fields without a version bump. The check
	// exists so a truncated keepalive PUT or a stray form post cannot leave the
	// endpoint serving something every reader will then reject on every cycle.
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "profile must be a JSON object"})
		return
	}
	if err := writeSyncBlob(path, body); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeSyncBlob publishes the bytes atomically: a uniquely-named temp file in
// the same directory, fsync'd, then renamed over the target. A concurrent PUT
// therefore never lets a GET observe a torn or half-written profile — it only
// decides which of two whole blobs survives, which is the last-writer-wins
// posture documented at the top of this file.
func writeSyncBlob(path string, body []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create profile dir: %w", err)
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.*")
	if err != nil {
		return fmt.Errorf("stage profile: %w", err)
	}
	tmp := f.Name()
	defer func() { _ = os.Remove(tmp) }() // no-op once the rename succeeded
	if _, err := f.Write(body); err != nil {
		_ = f.Close()
		return fmt.Errorf("write profile: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync profile: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close profile: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("publish profile: %w", err)
	}
	return nil
}
