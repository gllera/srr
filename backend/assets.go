package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"

	"srrb/mod"
	"srrb/store"
)

// errNotAsset classifies UploadCacheRef failures meaning "this reference is
// not an upload marker at all" — it names no regular file in the cache dir
// (an ordinary #fragment) or resolves outside it (attacker-influenced content
// must be ignored, not wedge the feed). The caller declines such references,
// leaving the value untouched; any other failure fails the fetch. The
// wrapping messages keep the specific reason.
var errNotAsset = errors.New("not a cache asset")

// assetFetcher uploads files into the store backend under a content-hash key,
// returning the relative key. The same key for given bytes makes uploads
// overwrite-safe and idempotent: it backs the end-of-pipeline self-hosting step
// (see UploadCacheRef).
type assetFetcher struct {
	be store.Backend
	// maxBytes is the asset size cap in bytes. The cap is ENFORCED AT DOWNLOAD
	// (#selfhost / external ingest); here it survives only as a fail-soft OOM
	// bound on the asset-process output read (readProcOutput), which is generated
	// at upload and so isn't download-bounded. Zero disables that guard.
	maxBytes int64
	proc     []string // asset-process command (transcode/process bytes); see runProcess
	peek     []string // asset-peek command (identify the asset up front); see runPeek

	// procTimeout bounds a single asset-process AND asset-peek command invocation,
	// separate from the shared SubprocessTimeout (--cmd-timeout) — which governs
	// ingest/mod commands, never asset work — because media transcoding can run far
	// longer than a feed/ingest command. Set from --asset-process-timeout in
	// cmd_fetch.go; a zero value (the default) means UNLIMITED — no deadline,
	// bounded only by run cancellation.
	procTimeout time.Duration

	// procDir is the staging dir for asset-process {output} files —
	// <cache-dir>/_processed, set by cmd_fetch.go alongside baseCtx/sem. Big
	// transcodes must not land in a (often tmpfs, RAM-backed) OS temp dir, and
	// a crash-leaked output inside the cache tree is reclaimed by the
	// post-cycle age sweep (sweepAssetCache). Empty falls back to the OS temp
	// dir (bare newAssetFetcher callers).
	procDir string

	// seen memoizes source-content-hash -> resolved store key for this run, so a
	// marker reused across a feed's articles (or across feeds) skips the repeat
	// asset-peek subprocess and store existence round-trip. Concurrent-safe (the
	// fetcher is shared across workers); the store existence check below stays the
	// cross-run and cross-worker-race backstop.
	seen sync.Map

	// flight coalesces concurrent UploadCacheRef calls for the same source bytes
	// into a single peek/process/upload. The parallel upload step
	// (fetchRun.uploadAssets) can hand one asset to several item goroutines at
	// once — within a feed or across feeds sharing this run's fetcher — and the
	// seen memo only short-circuits AFTER the first finishes, so a concurrent wave
	// would otherwise each re-transcode and re-upload the same already-seen asset.
	// Keyed by source content hash (the seen key), so distinct sources never
	// serialize against each other.
	flight singleflight.Group

	// sem is the run-global asset worker pool: only the singleflight LEADER (the
	// goroutine that actually peeks/transcodes/uploads a unique asset) holds a
	// slot, so followers coalescing on the same bytes never pin one. Sized by
	// SRR_ASSET_WORKERS in cmd_fetch.go (cap >= 1).
	sem chan struct{}

	// baseCtx is the run/shutdown context the singleflight body runs under (set in
	// cmd_fetch.go). It is deliberately decoupled from any single feed's errgroup
	// context: the fetcher is shared across feeds, so a follower feed must not be
	// poisoned by the leader feed's cancellation — only run shutdown aborts the
	// shared peek/transcode/upload. (containedctx: a run-scoped helper, by design.)
	baseCtx context.Context

	// active/done count leader jobs for the fetch status line: active while a
	// leader holds a worker slot (peeking/transcoding/uploading a unique asset),
	// done bumped as each leader job completes (success or failure — a job
	// counter, not a success meter). Followers and memo hits don't count.
	active, done atomic.Int64
}

// assetPrefix is the reserved store prefix for self-hosted media, analogous to
// idx/ and data/. The frontend resolves keys under this prefix against the
// pack base.
const assetPrefix = "assets/"

// newAssetFetcher builds the run's asset uploader. maxKB caps a single stored
// object's size. procCmd (asset-process) is the optional command run per asset
// to process its bytes — split on whitespace, empty disabling it. The optional
// asset-peek command is assigned to the returned fetcher's peek field by the
// caller (cmd_fetch), before workers run. See runProcess / runPeek for the
// {input}/{output} token contract.
func newAssetFetcher(be store.Backend, maxKB int, procCmd string) *assetFetcher {
	return &assetFetcher{
		be:       be,
		maxBytes: int64(maxKB) * (1 << 10),
		proc:     strings.Fields(procCmd),
		// Valid out of the box so any caller can run UploadCacheRef: a never-cancel
		// base ctx and a single-slot worker pool. FetchCmd.fetch overrides both —
		// baseCtx with the run/shutdown ctx, sem sized by SRR_ASSET_WORKERS — before
		// workers run, so run shutdown propagates and the pool matches the flag.
		baseCtx: context.Background(),
		sem:     make(chan struct{}, 1),
	}
}

// UploadCacheRef resolves localname inside cacheDir and uploads the file to the
// store under a key derived from the ORIGINAL file's content hash, returning
// that key. It backs the end-of-pipeline upload step (inlined in feed.fetch):
// an out-of-repo ingest fetcher downloads files into the run's shared cache dir
// and refers to them by relative path in item content; SRR owns the assets/ key
// (sha256 of the source bytes, so identical content from any source dedups) and
// the upload, so the fetcher needs no store credentials.
//
// The dedup key hashes the SOURCE bytes (so an asset already in the store is
// returned without re-running asset-process or the upload), but its extension
// comes from asset-peek when configured — the probe that predicts the
// post-process format and runs before the existence check. On a miss the
// asset-process command (if configured, and the asset is peek-supported)
// processes the file just before upload.
//
// Guards (localname comes from item content, which may be attacker-influenced):
// the resolved path must stay within cacheDir (no "..", no symlinked escape) and
// must be a regular file. The asset size cap is NOT checked here — it is enforced
// at download by whoever fetched the file (#selfhost / external ingest), so the
// cache file is trusted; only the asset-process output keeps a fail-soft guard.
func (a *assetFetcher) UploadCacheRef(ctx context.Context, cacheDir, localname string) (string, error) {
	if localname == "" {
		return "", fmt.Errorf("empty asset reference: %w", errNotAsset)
	}

	full := filepath.Join(cacheDir, filepath.FromSlash(localname))

	// Reject symlinks and non-regular files outright (Lstat does not follow the
	// final component).
	fi, err := os.Lstat(full)
	if err != nil {
		return "", fmt.Errorf("stat asset %q: %w: %w", localname, errNotAsset, err)
	}
	if !fi.Mode().IsRegular() {
		return "", fmt.Errorf("asset %q is not a regular file: %w", localname, errNotAsset)
	}

	// Containment: resolve symlinks on both sides and confirm the file stays
	// under the cache dir, so neither a "../" reference nor a symlinked path
	// component can point the upload at an arbitrary file.
	root, err := filepath.EvalSymlinks(cacheDir)
	if err != nil {
		return "", fmt.Errorf("resolve cache dir: %w", err)
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", fmt.Errorf("resolve asset %q: %w", localname, err)
	}
	if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("asset %q escapes cache dir: %w", localname, errNotAsset)
	}

	// The self-hosted-object size cap is enforced at DOWNLOAD by whoever fetched
	// the file (the #selfhost mod or an external ingest command, via
	// Request.MaxAssetSize) — so the cache file is trusted here and read without a
	// re-check. Only the asset-process output, generated below and NOT
	// download-bounded, keeps a fail-soft size guard (see readProcOutput).
	//
	// Key on the ORIGINAL file's content hash so an asset already in the store is
	// recognized before the (possibly expensive) pre-upload processing runs.
	orig, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("read asset %q: %w", localname, err)
	}
	sum := sha256.Sum256(orig)

	// Mark the source file as consumed: the post-cycle age sweep
	// (sweepAssetCache) treats mtime as "last relevant", so touching here —
	// before the memo/store-hit/upload branching — guarantees a file the
	// pipeline still references never ages out, even when the ingest strategy
	// that cached it doesn't refresh mtimes on reuse itself. Best-effort.
	if now := time.Now(); os.Chtimes(full, now, now) != nil {
		slog.Debug("asset touch failed", "asset", localname)
	}

	// Within-run memo: identical source bytes resolve to one key, so a marker
	// reused across articles/feeds in this fetch short-circuits before the repeat
	// asset-peek subprocess and the store existence round-trip below.
	if cached, ok := a.seen.Load(sum); ok {
		return cached.(string), nil
	}

	// Coalesce a concurrent wave referencing the SAME source bytes into one
	// peek/process/upload (the parallel upload step can hand one asset to many
	// item goroutines before the memo above is populated). Only the LEADER runs
	// the body — and holds a worker slot (a.sem); followers wait on the channel
	// WITHOUT a slot, so a heavy shared transcode can't starve distinct-asset
	// jobs. The body runs under a.baseCtx (the run/shutdown ctx), NOT the caller's
	// per-feed ctx, so one feed's cancellation can't poison a follower feed sharing
	// the asset; only run shutdown aborts it. The leader's result — success or
	// error — is shared with the wave (a shared asset that fails to upload fails
	// every referencing feed; each self-heals next fetch), and singleflight re-runs
	// for the next wave, so a transient failure isn't cached.
	ch := a.flight.DoChan(string(sum[:]), func() (any, error) {
		select {
		case a.sem <- struct{}{}:
		case <-a.baseCtx.Done():
			return nil, a.baseCtx.Err()
		}
		defer func() { <-a.sem }()
		a.active.Add(1)
		defer func() { a.active.Add(-1); a.done.Add(1) }()
		return a.resolveAndUpload(a.baseCtx, full, localname, orig, sum)
	})
	// A follower whose own feed is cancelling bails here without waiting on the
	// leader (and without ever taking a slot); the leader's body still completes
	// and caches the result for the next wave.
	select {
	case res := <-ch:
		if res.Err != nil {
			return "", res.Err
		}
		return res.Val.(string), nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// resolveAndUpload is the single-flighted body of UploadCacheRef: it identifies
// the asset (asset-peek), checks the store for the content-hash key, and — on a
// miss — runs asset-process and uploads, memoizing the resolved key. full is the
// validated cache-file path, orig its bytes, sum their hash. Concurrent
// UploadCacheRef calls for the same sum share one invocation (see flight).
func (a *assetFetcher) resolveAndUpload(ctx context.Context, full, localname string, orig []byte, sum [32]byte) (string, error) {
	// asset-peek (if configured) identifies the asset up front — before the dedup
	// check — so the key reflects the post-process format while dedup still keys
	// on the source bytes. It sets the stored extension (a transcoded asset then
	// carries its true output extension), its Content-Type/-Encoding, and whether
	// asset-process should run at all (supported). Fail-soft: a peek error or
	// invalid JSON falls back to the source extension and leaves the asset
	// supported (asset-process runs if configured).
	storedExt := path.Ext(localname)
	supported := true
	var meta store.ObjectMeta
	if len(a.peek) > 0 {
		if pr, ok := a.runPeek(ctx, full, localname); ok {
			if ext := normalizeExt(pr.Extension); ext != "" {
				storedExt = ext
			}
			supported = pr.Supported
			meta = pr.objectMeta()
		}
	}
	key := contentHashKey(storedExt, sum)

	// Already uploaded? Skip the asset-process command and the upload — the common
	// case for an image reused across articles or feeds. (asset-peek still ran, to
	// fix the key extension; it is the cheap probe.)
	if rc, err := a.be.Get(ctx, key, true); err != nil {
		return "", fmt.Errorf("check asset %q: %w", key, err)
	} else if rc != nil {
		rc.Close()
		slog.Debug("asset already stored, skipping process+upload", "asset", localname, "key", key)
		a.seen.Store(sum, key)
		return key, nil
	}
	slog.Debug("asset store miss, processing+uploading", "asset", localname, "key", key)

	// First time we've seen these bytes: run the configured asset-process command
	// (any processing — e.g. media transcoding) on the file just before upload,
	// unless asset-peek marked the asset unsupported (host it as-is). In {output}
	// mode the command declares the result's Content-Type/-Encoding — the actual
	// result, so it wins over peek's prediction. The key keeps the peek extension
	// (decided before the dedup check); a process extension that disagrees only
	// warns. Fail-soft: a command that errors or emits nothing uploads the
	// original unchanged.
	payload := orig
	if supported && len(a.proc) > 0 {
		if b, pm, ok := a.runProcess(ctx, full, localname); ok {
			payload = b
			if pm.Mimetype != "" || pm.Encoding != "" {
				meta = pm.objectMeta()
			}
			if pe := normalizeExt(pm.Extension); pe != "" && pe != storedExt {
				slog.Warn("asset-process extension differs from asset-peek; keeping the peek key", "asset", localname, "peek", storedExt, "process", pe)
			}
		}
	}

	if err := a.be.AtomicPut(ctx, key, bytes.NewReader(payload), meta); err != nil {
		return "", fmt.Errorf("store asset %q: %w", key, err)
	}
	a.seen.Store(sum, key)
	return key, nil
}

// inputToken / outputToken mark where an asset command (process or peek)
// receives the cache file path and (asset-process only) an output path. {input}
// is substituted per arg (e.g. "enc -i {input} --flags"); with no {input} the
// path is appended as the final arg. {output} switches asset-process to file
// mode: SRR substitutes a fresh temp path, reads the processed bytes back from
// it, and parses a metadata JSON from stdout. With no {output} the command
// writes processed bytes to stdout.
const (
	inputToken  = "{input}"
	outputToken = "{output}"
)

// buildAssetArgv assembles the argv for an asset command: full is substituted
// for every {input} token (appended as the final arg when no arg carries one),
// and outPath — when non-empty — for every {output} token. It never mutates spec
// (shared across workers). Shared by runProcess and runPeek so the token
// contract lives in one place.
func buildAssetArgv(spec []string, full, outPath string) []string {
	hasInput := false
	argv := make([]string, len(spec))
	for i, f := range spec {
		if strings.Contains(f, inputToken) {
			hasInput = true
		}
		f = strings.ReplaceAll(f, inputToken, full)
		if outPath != "" {
			f = strings.ReplaceAll(f, outputToken, outPath)
		}
		argv[i] = f
	}
	if !hasInput {
		argv = append(argv, full)
	}
	return argv
}

// assetMeta is the type/encoding an asset-peek or asset-process command reports
// on stdout (JSON): it feeds the stored object's Content-Type/-Encoding and, for
// peek, the key extension.
type assetMeta struct {
	Mimetype  string `json:"mimetype"`
	Extension string `json:"extension"`
	Encoding  string `json:"encoding"`
}

// objectMeta maps the reported type/encoding onto the store's response-header
// metadata (the field-name translation lives here, not at each call site).
func (m assetMeta) objectMeta() store.ObjectMeta {
	return store.ObjectMeta{ContentType: m.Mimetype, ContentEncoding: m.Encoding}
}

// peekResult is the JSON an asset-peek command prints to stdout: the identified
// assetMeta plus whether asset-process supports the file.
type peekResult struct {
	assetMeta
	Supported bool `json:"supported"`
}

// runProcess runs the configured asset-process command on the cache file just
// before upload, returning the processed bytes and (in {output} mode) the
// metadata it declared. The cache file path is substituted for every {input}
// token (per arg); with no token it is appended as the final argument. In
// {output} mode (an arg carries {output}) SRR substitutes a fresh staging path
// under procDir (<cache-dir>/_processed; OS temp dir when unset), reads the
// processed bytes back from that file, and parses a metadata JSON from
// stdout; otherwise the bytes are read from stdout (no declared metadata).
// stderr is captured, not passed through — a transcoder's progress narration
// would garble srr's own output — and its tail rides the error into the warn
// line on failure (see mod.RunCommandTimeout). Fail-soft: it returns ok=false — the
// caller uploads the original unchanged — when the command errors, writes no
// output, or (file mode) prints invalid metadata, so a processing hiccup or an
// unhandled file type never wedges a feed. Runs through mod.RunCommandTimeout
// under procTimeout (--asset-process-timeout, its own much longer bound since
// transcoding can outlast a feed/ingest command), keeping the WaitDelay and
// capped-stdout hardening: a hung transcoder can't wedge the worker and runaway
// output can't OOM it.
func (a *assetFetcher) runProcess(ctx context.Context, full, localname string) ([]byte, assetMeta, bool) {
	hasOutput := false
	for _, f := range a.proc {
		if strings.Contains(f, outputToken) {
			hasOutput = true
			break
		}
	}

	// {output} mode: a fresh staging file the command writes its result to,
	// under <cache-dir>/_processed (procDir; OS temp dir when unset). The
	// source extension is a hint for tools that pick a format from it; SRR reads
	// the bytes back regardless. Removed on every path below; a leak from a
	// crash mid-transcode ages out via the cache sweep.
	var outPath string
	if hasOutput {
		if a.procDir != "" {
			if err := os.MkdirAll(a.procDir, 0o700); err != nil {
				slog.Warn("asset-process: create staging dir failed; uploading original", "asset", localname, "err", err)
				return nil, assetMeta{}, false
			}
		}
		tmp, err := os.CreateTemp(a.procDir, "srr-asset-*"+path.Ext(localname))
		if err != nil {
			slog.Warn("asset-process: create output file failed; uploading original", "asset", localname, "err", err)
			return nil, assetMeta{}, false
		}
		outPath = tmp.Name()
		tmp.Close()
		defer os.Remove(outPath)
	}

	argv := buildAssetArgv(a.proc, full, outPath)
	// procTimeout <= 0 means unlimited (the default): RunCommandTimeout adds no
	// deadline, so a long media transcode is never capped by a timeout — only run
	// cancellation (SIGINT/SIGTERM) stops it. A positive value bounds the command.
	out, err := mod.RunCommandTimeout(ctx, a.procTimeout, argv[0], argv[1:]...)
	if err != nil {
		slog.Warn("asset-process command failed; uploading original", "asset", localname, "cmd", a.proc[0], "err", err)
		return nil, assetMeta{}, false
	}

	if !hasOutput {
		// stdout mode: the processed bytes are stdout; no declared metadata.
		if len(out) == 0 {
			slog.Warn("asset-process command produced no output; uploading original", "asset", localname, "cmd", a.proc[0])
			return nil, assetMeta{}, false
		}
		// Same fail-soft size guard as the {output} path (readProcOutput): the
		// process output is generated here and isn't download-bounded, so an
		// over-cap result uploads the original instead. (RunCommandTimeout already
		// bounds stdout at 64 MiB for OOM safety; this enforces --max-asset-size.)
		if a.maxBytes > 0 && int64(len(out)) > a.maxBytes {
			slog.Warn("asset-process output exceeds cap; uploading original", "asset", localname, "size", len(out), "cap", a.maxBytes)
			return nil, assetMeta{}, false
		}
		return out, assetMeta{}, true
	}

	// {output} mode: bytes from the file, metadata JSON from stdout.
	payload, ok := a.readProcOutput(outPath, localname)
	if !ok {
		return nil, assetMeta{}, false
	}
	var m assetMeta
	if err := json.Unmarshal(out, &m); err != nil {
		slog.Warn("asset-process metadata JSON invalid; uploading original", "asset", localname, "cmd", a.proc[0], "err", err)
		return nil, assetMeta{}, false
	}
	return payload, m, true
}

// readProcOutput reads the {output}-mode result file, bounding the read by the
// asset size cap so a runaway output can't OOM the worker. An empty, oversize,
// or unreadable file fails soft.
func (a *assetFetcher) readProcOutput(outPath, localname string) ([]byte, bool) {
	fi, err := os.Stat(outPath)
	if err != nil {
		slog.Warn("asset-process: stat output failed; uploading original", "asset", localname, "err", err)
		return nil, false
	}
	if a.maxBytes > 0 && fi.Size() > a.maxBytes {
		slog.Warn("asset-process output exceeds cap; uploading original", "asset", localname, "size", fi.Size(), "cap", a.maxBytes)
		return nil, false
	}
	payload, err := os.ReadFile(outPath)
	if err != nil {
		slog.Warn("asset-process: read output failed; uploading original", "asset", localname, "err", err)
		return nil, false
	}
	if len(payload) == 0 {
		slog.Warn("asset-process produced no output file; uploading original", "asset", localname, "cmd", a.proc[0])
		return nil, false
	}
	return payload, true
}

// runPeek runs the configured asset-peek command on the cache file to identify
// the asset before the dedup check, returning its parsed JSON and ok=true. The
// cache file path is substituted for every {input} token (per arg); with no
// token it is appended as the final arg. Fail-soft: ok=false (the caller falls
// back to the source extension and treats the asset as supported) when the
// command errors or prints invalid JSON, so a peek hiccup never wedges a feed.
// Bounded by procTimeout (--asset-process-timeout, unlimited by default), the same
// as runProcess — the shared --cmd-timeout deliberately does NOT govern asset work.
func (a *assetFetcher) runPeek(ctx context.Context, full, localname string) (peekResult, bool) {
	argv := buildAssetArgv(a.peek, full, "")
	out, err := mod.RunCommandTimeout(ctx, a.procTimeout, argv[0], argv[1:]...)
	if err != nil {
		slog.Warn("asset-peek failed; using source extension", "asset", localname, "cmd", a.peek[0], "err", err)
		return peekResult{}, false
	}
	var pr peekResult
	if err := json.Unmarshal(out, &pr); err != nil {
		slog.Warn("asset-peek JSON invalid; using source extension", "asset", localname, "cmd", a.peek[0], "err", err)
		return peekResult{}, false
	}
	return pr, true
}

// normalizeExt returns ext with a leading dot ("webp" -> ".webp"), leaving an
// empty string and an already-dotted extension untouched, so an asset-peek /
// asset-process command may report the extension either way.
func normalizeExt(ext string) string {
	if ext == "" || strings.HasPrefix(ext, ".") {
		return ext
	}
	return "." + ext
}

// contentHashKey derives the relative store key (assets/<2>/<16><ext>) from the
// content hash plus the given extension (leading dot). Content-addressed, so
// identical bytes from any source dedup to one key; the layout is part of the
// writer↔reader contract (the frontend resolves keys under assetPrefix against
// the pack base).
func contentHashKey(ext string, sum [32]byte) string {
	h := hex.EncodeToString(sum[:])
	return assetPrefix + h[:2] + "/" + h[:16] + ext
}
