package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"mime"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"srr/store"
)

// githubAPIBase is the GitHub REST API root. A package var so tests can point it
// at an httptest server.
var githubAPIBase = "https://api.github.com"

// maxFrontendDownload caps the release-asset download so a malformed/hostile
// response can't stream unbounded into memory (the SPA bundle is well under 1 MiB).
const maxFrontendDownload = 64 << 20 // 64 MiB

const (
	// frontendAsset is the release asset that carries the built SPA, a flat
	// tarball (`tar czf srrf.tar.gz -C dist/srrf .`).
	frontendAsset = "srrf.tar.gz"
	// sitemapKey is the store-root manifest of frontend files this command owns,
	// used to clean up the previous version's orphaned files on upgrade.
	sitemapKey = "sitemap.txt"
)

// frontendMime maps the file extensions the published SPA bundle ships to a
// deterministic Content-Type, independent of the host's mime database (which
// can otherwise serve .js as application/javascript or omit .webmanifest). Used
// to stamp store.ObjectMeta on each uploaded file so S3-hosted stores render the
// reader correctly (local/SFTP ignore it — the static server sets types by
// extension at request time).
var frontendMime = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
}

// mimeForKey returns the Content-Type for a frontend file key: the deterministic
// override when known, else the host mime table, else octet-stream.
func mimeForKey(key string) string {
	ext := strings.ToLower(path.Ext(key))
	if m, ok := frontendMime[ext]; ok {
		return m
	}
	if m := mime.TypeByExtension(ext); m != "" {
		return m
	}
	return "application/octet-stream"
}

// cleanTarName strips the leading "./" that `tar -C dir .` writes and rejects any
// name that is not a flat, safe store key — absolute, parent-traversing, or
// nested. The SPA bundle is flat (a store-root key per file), so a name with a
// path separator signals a malformed or hostile tarball.
func cleanTarName(raw string) (string, error) {
	name := strings.TrimPrefix(raw, "./")
	if name == "" || name == "." || strings.HasPrefix(name, "/") ||
		strings.Contains(name, "..") || strings.Contains(name, "/") {
		return "", fmt.Errorf("unsafe frontend file name %q", raw)
	}
	return name, nil
}

// extractTarGz decompresses the SPA tarball into a key→bytes map. Only regular
// files are kept (directory entries are skipped); each name is validated as a
// flat store key. An empty result is an error (a bundle must ship files).
func extractTarGz(data []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("opening %s gzip: %w", frontendAsset, err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("reading %s tar: %w", frontendAsset, err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		name, err := cleanTarName(h.Name)
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return nil, fmt.Errorf("reading %s from %s: %w", name, frontendAsset, err)
		}
		files[name] = b
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("%s contained no files", frontendAsset)
	}
	return files, nil
}

// FrontendGroup is `srr frontend` (alias `fe`).
type FrontendGroup struct {
	Update FrontendUpdateCmd `cmd:"" help:"Download the latest frontend build from GitHub and upload it into the store root."`
}

// FrontendUpdateCmd is `srr frontend update`: install the latest published SPA
// into the store root so one static origin serves both the reader and the packs.
type FrontendUpdateCmd struct {
	Repo string `default:"gllera/srr" env:"SRR_FE_REPO" help:"GitHub repo (owner/name) to install the frontend release from."`
	Tag  string `help:"Release tag to install (default: the latest release)."`
}

func (o *FrontendUpdateCmd) Run() error {
	ctx := context.Background()
	backend, err := store.Open(ctx, globals.Store)
	if err != nil {
		return err
	}
	defer backend.Close()
	return frontendUpdate(ctx, backend, &http.Client{Timeout: 2 * time.Minute}, o.Repo, o.Tag)
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type ghReleaseInfo struct {
	Tag    string    `json:"tag_name"`
	Assets []ghAsset `json:"assets"`
}

func (r ghReleaseInfo) assetURL(name string) (string, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL, true
		}
	}
	return "", false
}

// resolveRelease fetches the release metadata: the latest release, or the named
// tag when set. Unauthenticated — the repo is public and the rate limit is ample
// for a manual command.
func resolveRelease(ctx context.Context, client *http.Client, repo, tag string) (ghReleaseInfo, error) {
	url := githubAPIBase + "/repos/" + repo + "/releases/latest"
	if tag != "" {
		url = githubAPIBase + "/repos/" + repo + "/releases/tags/" + tag
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ghReleaseInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := client.Do(req)
	if err != nil {
		return ghReleaseInfo{}, fmt.Errorf("fetching release for %s: %w", repo, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ghReleaseInfo{}, fmt.Errorf("github release api %s: %s", url, res.Status)
	}
	var rel ghReleaseInfo
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return ghReleaseInfo{}, fmt.Errorf("decoding release json: %w", err)
	}
	return rel, nil
}

func downloadAsset(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", frontendAsset, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading %s: %s", url, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxFrontendDownload+1))
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", frontendAsset, err)
	}
	if len(data) > maxFrontendDownload {
		return nil, fmt.Errorf("%s exceeds the %d-byte cap", frontendAsset, maxFrontendDownload)
	}
	return data, nil
}

// frontendUpdate installs the published SPA into the store root and reconciles
// the sitemap.txt manifest so no file from a prior (or a crashed) run is left
// dangling. See the no-dangling invariant in the design: sitemap.txt is, at every
// interruptible point, a superset of the frontend files actually present.
func frontendUpdate(ctx context.Context, backend store.Backend, client *http.Client, repo, tag string) error {
	rel, err := resolveRelease(ctx, client, repo, tag)
	if err != nil {
		return err
	}
	url, ok := rel.assetURL(frontendAsset)
	if !ok {
		return fmt.Errorf("release %s has no %s asset", rel.Tag, frontendAsset)
	}
	data, err := downloadAsset(ctx, client, url)
	if err != nil {
		return err
	}
	newFiles, err := extractTarGz(data)
	if err != nil {
		return err
	}

	oldKeys, err := readSitemap(ctx, backend)
	if err != nil {
		return err
	}
	newKeys := sortedKeys(newFiles)

	// Prefer the STORE over the bookkeeping: sitemap.txt exists only because
	// there was no way to ask a store what it holds, and a manifest of past
	// intent is wrong in exactly the ways a listing is not — it was never
	// written (an interrupted first install), it was deleted, or the files
	// predate this command entirely. Whatever the listing finds is folded into
	// the old set, so those orphans get reclaimed on this run instead of never.
	listed, err := listHashedShellAssets(ctx, backend)
	if err != nil {
		return err
	}
	oldKeys = union(oldKeys, listed)

	// The pending-superset write STAYS, on a listable store too. It is one tiny
	// PUT, and it covers the one class the listing deliberately cannot: a
	// STABLE-named file (index.html, manifest.webmanifest, an unhashed icon a
	// future bundle drops) is indistinguishable from an operator's own root
	// object, so only a record of having uploaded it can ever authorise its
	// deletion. Old ∪ new tracks every file about to exist, so a crash
	// mid-upload still leaves nothing untracked.
	if err := writeSitemap(ctx, backend, union(oldKeys, newKeys)); err != nil {
		return fmt.Errorf("writing pending sitemap: %w", err)
	}

	// Upload index.html last so a reader mid-update never sees a new entry point
	// referencing a not-yet-uploaded asset. Abort on any error — the old files and
	// the pending manifest remain, so the old reader works and the next run finishes.
	for _, key := range uploadOrder(newKeys) {
		meta := store.ObjectMeta{ContentType: mimeForKey(key)}
		if err := backend.AtomicPut(ctx, key, bytes.NewReader(newFiles[key]), meta); err != nil {
			return fmt.Errorf("uploading %s: %w", key, err)
		}
	}

	// Delete the previous version's orphans. A failed delete stays tracked (it is
	// kept in the final manifest) so the next run retries it — never dropped.
	newSet := toSet(newKeys)
	var failed []string
	removed := 0
	for _, key := range oldKeys {
		if newSet[key] {
			continue
		}
		if err := backend.Rm(ctx, key); err != nil {
			slog.Warn("frontend: removing stale file failed", "key", key, "err", err)
			failed = append(failed, key)
			continue
		}
		removed++
	}

	if err := writeSitemap(ctx, backend, union(newKeys, failed)); err != nil {
		return fmt.Errorf("writing sitemap: %w", err)
	}
	slog.Info("frontend updated", "version", rel.Tag, "files", len(newKeys), "removed", removed)
	return nil
}

// listHashedShellAssets asks the store which CONTENT-HASHED frontend assets it
// holds at the root. That class and no other: a hashed name is machine-minted
// per build (`frontend.5730a221.js`), so it is unambiguously this command's
// output and it is the class that ACCUMULATES — every release mints new ones
// and strands the last release's. `store.HashedFrontendAsset`'s grammar is
// slash-free and anchored, so a pack key, db.gz, config.gz, sitemap.txt or an
// operator's own root file can never match, and this function can therefore
// never propose deleting one.
//
// A backend that cannot list is not an error: `srr frontend update` keeps the
// sitemap path it always had. Neither is the cost — the listing walks the whole
// store, which on a large one is many pages, but this is a manual command run
// once per release.
func listHashedShellAssets(ctx context.Context, backend store.Backend) ([]string, error) {
	keys, err := backend.List(ctx, "")
	if errors.Is(err, errors.ErrUnsupported) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listing the store root: %w", err)
	}
	var out []string
	for _, k := range keys {
		if store.HashedFrontendAsset(k) {
			out = append(out, k)
		}
	}
	return out, nil
}

// readSitemap parses the store-root manifest into the set of keys this command
// owns. A missing manifest (first install) is an empty set, not an error.
func readSitemap(ctx context.Context, backend store.Backend) ([]string, error) {
	rc, err := getOptional(ctx, backend, sitemapKey)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", sitemapKey, err)
	}
	if rc == nil {
		return nil, nil
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", sitemapKey, err)
	}
	var keys []string
	for line := range strings.SplitSeq(string(data), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			keys = append(keys, line)
		}
	}
	return keys, nil
}

func writeSitemap(ctx context.Context, backend store.Backend, keys []string) error {
	body := strings.Join(keys, "\n")
	if body != "" {
		body += "\n"
	}
	return backend.AtomicPut(ctx, sitemapKey, strings.NewReader(body), store.ObjectMeta{ContentType: mimeForKey(sitemapKey)})
}

func sortedKeys(m map[string][]byte) []string {
	return slices.Sorted(maps.Keys(m))
}

func toSet(keys []string) map[string]bool {
	s := make(map[string]bool, len(keys))
	for _, k := range keys {
		s[k] = true
	}
	return s
}

// union returns the sorted set-union of two key slices.
func union(a, b []string) []string {
	s := toSet(a)
	for _, k := range b {
		s[k] = true
	}
	return slices.Sorted(maps.Keys(s))
}

// uploadOrder keeps the (already sorted) keys but moves index.html to the end.
func uploadOrder(keys []string) []string {
	out := make([]string, 0, len(keys))
	hasIndex := false
	for _, k := range keys {
		if k == "index.html" {
			hasIndex = true
			continue
		}
		out = append(out, k)
	}
	if hasIndex {
		out = append(out, "index.html")
	}
	return out
}
