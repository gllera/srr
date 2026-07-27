package main

import (
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"time"
)

// The scoped flag structs: the ~18 fetch/write-cycle knobs that used to sit on
// Globals and be flattened into every command's help. Each embedding command
// gets them as grouped flags; AfterApply (run by kong.Parse for the selected
// command only — never by tests calling Run/internals directly) copies the
// resolved values into the runtime `globals` and floors them. Commands that
// embed nothing run on seedScopedDefaults' seeds instead.

// scopedFlagNamesList names every flag the structs below declare. It is BOTH
// the yaml-resolution allowlist (configResolver routes exactly these to their
// bare top-level srr.yaml key, so existing config files keep working at any
// command depth) and the help-noise test's pin. Adding a field to any scoped
// struct requires adding its flag name here — TestScopedFlagsAreNotGlobal
// fails on the mismatch in either direction.
var scopedFlagNamesList = []string{
	"pack-size", "max-deltas", "max-delta-bytes", "max-batch-bytes",
	"max-asset-size", "asset-process", "asset-peek", "asset-workers",
	"asset-process-timeout", "cache-dir", "cache-max-age",
	"fetch-backoff-max", "notify", "notify-after",
	"keep-manifests",
	"max-feed-size", "cmd-timeout", "allow-private-fetch",
}

// cycleFlags: read only by a store-writing fetch cycle. Embedded in fetch,
// serve, mcp (and config, which prints resolved values).
type cycleFlags struct {
	PackSize            int           `default:"${packSize}"      env:"SRR_PACK_SIZE"     help:"Target pack size in KB."`
	MaxDeltas           int           `default:"${maxDeltas}" env:"SRR_MAX_DELTAS" help:"Max delta segments (data/d<g>.gz, one per article-producing cycle) before a cycle consolidates them into the tail packs. Bounds a cold reader's extra requests. 0 disables deltas: every dirty cycle rewrites the tail packs (the pre-delta behavior)."`
	MaxDeltaBytes       int           `default:"${maxDeltaBytes}" env:"SRR_MAX_DELTA_BYTES" help:"Consolidate the tail once the live delta segments hold more than this many KB of uncompressed article JSONL (bounds a cold reader's delta payload)."`
	MaxBatchBytes       int           `default:"${maxBatchBytes}" env:"SRR_MAX_BATCH_BYTES" help:"Drive one cycle's article batch through pack materialization in sub-batches of at most this many KB of uncompressed article JSONL, so a large backfill's transient memory is bounded by the cap rather than by the batch. Chunking is byte-invisible in the store. 0 disables it: the whole batch materializes in one pass."`
	MaxAssetSize        int           `default:"${maxAssetSize}"    env:"SRR_MAX_ASSET_SIZE" help:"Max self-hosted asset object size in KB."`
	AssetProcess        string        `env:"SRR_ASSET_PROCESS" help:"Command run on every self-hosted asset just before upload to process its bytes, e.g. transcode media. The cache file path is substituted for each {input} token, or appended as the final arg when absent. With a {output} token the command writes its result to that file and prints a {mimetype,extension,encoding} JSON to stdout (setting the stored Content-Type/-Encoding); without {output}, processed bytes are read from stdout. Non-zero exit or empty output keeps the original. Skipped when the source is already uploaded. Empty disables. E.g. \"webify -m 720\" or \"conv -i {input} -o {output}\"."`
	AssetPeek           string        `env:"SRR_ASSET_PEEK" help:"Command run on every self-hosted asset (before the dedup check) to identify it: it receives the cache file path (substituted for each {input} token, or appended) and prints a {mimetype,extension,supported} JSON to stdout. The extension sets the stored object's key/extension (so a transcoded asset carries its true output extension) and mimetype its Content-Type; supported=false hosts the original bytes and skips asset-process. A non-zero exit or invalid JSON falls back to the source extension. Empty disables. E.g. \"identify-asset {input}\"."`
	AssetWorkers        int           `env:"SRR_ASSET_WORKERS" default:"${nproc}" help:"Max assets processed concurrently across all feeds (peek/transcode/upload). Independent of --workers."`
	AssetProcessTimeout time.Duration `env:"SRR_ASSET_PROCESS_TIMEOUT" default:"0" help:"Timeout for a single asset-process or asset-peek command invocation (Go duration). 0 (the default) means unlimited — no deadline, since media transcoding can run arbitrarily long; the command is still bounded by run cancellation (SIGINT/SIGTERM). The shared --cmd-timeout governs ingest/mod commands only and never affects asset processing."`
	CacheDir            string        `default:"${cacheDir}"        env:"SRR_CACHE_DIR"     help:"Local download cache for external ingest media."`
	CacheMaxAge         time.Duration `env:"SRR_CACHE_MAX_AGE" default:"72h" help:"Delete ingest-cache files unused for longer than this, swept after each fetch cycle. Downloads are consumed (uploaded to the store) within their cycle, and cache reuse refreshes a file's mtime, so old files are garbage. 0 disables the sweep."`
	FetchBackoffMax     time.Duration `default:"1h" env:"SRR_FETCH_BACKOFF_MAX" help:"Loop-only: cap the adaptive per-feed poll interval a dormant feed drifts to (grows as time-since-last-new/8 from --interval). 0 disables backoff (poll every feed every cycle)."`
	Notify              string        `env:"SRR_NOTIFY" help:"Shell command run when a feed crosses --notify-after consecutive failures, and again when it recovers. Context arrives as SRR_NOTIFY_EVENT (fail|recover), _FEED, _FEED_ID, _URL, _ERROR, _STREAK. Empty (default) disables alerting."`
	NotifyAfter         int           `default:"5" env:"SRR_NOTIFY_AFTER" help:"Consecutive failures before --notify fires (the crossing alerts once per outage)."`
}

func (f *cycleFlags) AfterApply() error {
	g := globals
	g.PackSize = f.PackSize
	g.MaxDeltas, g.MaxDeltaBytes, g.MaxBatchBytes = f.MaxDeltas, f.MaxDeltaBytes, f.MaxBatchBytes
	g.MaxAssetSize = f.MaxAssetSize
	g.AssetProcess, g.AssetPeek = f.AssetProcess, f.AssetPeek
	g.AssetWorkers, g.AssetProcessTimeout = f.AssetWorkers, f.AssetProcessTimeout
	g.CacheDir, g.CacheMaxAge = f.CacheDir, f.CacheMaxAge
	g.FetchBackoffMax = f.FetchBackoffMax
	g.Notify, g.NotifyAfter = f.Notify, f.NotifyAfter
	g.floorScoped()
	return nil
}

// gcFlags: the GC grace window, needed by every command that runs GC — fetch,
// serve, mcp, compact (and config).
type gcFlags struct {
	KeepManifests int `default:"${keepManifests}" env:"SRR_KEEP_MANIFESTS" help:"GC grace window K: generation manifests kept alongside the current one, and with them every object they name. A reader whose root is up to K generations stale still resolves its own snapshot; anything older is reclaimed and the reader self-heals with one guarded reload."`
}

func (f *gcFlags) AfterApply() error {
	globals.KeepManifests = f.KeepManifests
	globals.floorScoped()
	return nil
}

// netFlags: outbound-HTTP knobs shared by the cycle AND the probe paths
// (preview, subscribe-time discovery in feed add/upd -u/import).
type netFlags struct {
	MaxFeedSize       int           `short:"m" default:"${maxFeedSize}"     env:"SRR_MAX_FEED_SIZE" help:"Max feed download size in KB."`
	CmdTimeout        time.Duration `default:"0" env:"SRR_CMD_TIMEOUT" help:"Timeout for a single external ingest/mod command (Go duration). 0 (the default) means unlimited — no deadline; the command is still bounded by run cancellation (SIGINT/SIGTERM)."`
	AllowPrivateFetch bool          `env:"SRR_ALLOW_PRIVATE_FETCH" help:"Disable the SSRF guard, allowing fetches from private/loopback addresses. Security override — leave off unless you fetch LAN/localhost feeds."`
}

func (f *netFlags) AfterApply() error {
	g := globals
	g.MaxFeedSize = f.MaxFeedSize
	g.CmdTimeout = f.CmdTimeout
	g.AllowPrivateFetch = f.AllowPrivateFetch
	g.floorScoped()
	return nil
}

// floorScoped enforces the value floors that used to live post-parse in
// main(): a zero/negative size cap would disable guards (MaxAssetSize) or make
// the writer roll a pack per line (PackSize), and a KeepManifests below the
// compile-time contract lets GC reclaim faster than readers tolerate.
// Idempotent; called by the seed and by every AfterApply.
func (g *Globals) floorScoped() {
	if g.PackSize < 1 {
		g.PackSize = defaultPackSize
	}
	if g.MaxFeedSize < 1 {
		g.MaxFeedSize = defaultMaxFeedSize
	}
	if g.MaxAssetSize < 1 {
		g.MaxAssetSize = defaultMaxAssetSize
	}
	if g.AssetWorkers < 1 {
		g.AssetWorkers = runtime.NumCPU()
	}
	if g.CacheDir == "" {
		g.CacheDir = defaultCacheDir()
	}
	if g.KeepManifests < keepManifests {
		slog.Warn("--keep-manifests below the reader grace-window contract; raising to the floor",
			"requested", g.KeepManifests, "floor", keepManifests)
		g.KeepManifests = keepManifests
	}
}

// seedScopedDefaults fills the scoped knobs of the runtime globals with their
// compiled defaults overridden by SRR_* env vars. Runs BEFORE kong.Parse for
// every command: embedding commands overwrite via AfterApply with fully
// resolved (flag > env > yaml > default) values; non-embedding commands that
// can still reach the writer (`feed rm` draining a live delta chain) run on
// these seeds, never on Go zero values. Yaml deliberately does NOT reach the
// seeds — a cycle knob in srr.yaml applies to the commands that declare the
// flag. A malformed env value warns and keeps the default.
func seedScopedDefaults(g *Globals) {
	g.PackSize = envInt("SRR_PACK_SIZE", defaultPackSize)
	g.MaxDeltas = envInt("SRR_MAX_DELTAS", maxDeltasDefault)
	g.MaxDeltaBytes = envInt("SRR_MAX_DELTA_BYTES", maxDeltaBytesDefault)
	g.MaxBatchBytes = envInt("SRR_MAX_BATCH_BYTES", maxBatchBytesDefault)
	g.MaxAssetSize = envInt("SRR_MAX_ASSET_SIZE", defaultMaxAssetSize)
	g.AssetProcess = envStr("SRR_ASSET_PROCESS", "")
	g.AssetPeek = envStr("SRR_ASSET_PEEK", "")
	g.AssetWorkers = envInt("SRR_ASSET_WORKERS", runtime.NumCPU())
	g.AssetProcessTimeout = envDur("SRR_ASSET_PROCESS_TIMEOUT", 0)
	g.CacheDir = envStr("SRR_CACHE_DIR", defaultCacheDir())
	g.CacheMaxAge = envDur("SRR_CACHE_MAX_AGE", 72*time.Hour)
	g.FetchBackoffMax = envDur("SRR_FETCH_BACKOFF_MAX", time.Hour)
	g.Notify = envStr("SRR_NOTIFY", "")
	g.NotifyAfter = envInt("SRR_NOTIFY_AFTER", 5)
	g.KeepManifests = envInt("SRR_KEEP_MANIFESTS", keepManifests)
	g.MaxFeedSize = envInt("SRR_MAX_FEED_SIZE", defaultMaxFeedSize)
	g.CmdTimeout = envDur("SRR_CMD_TIMEOUT", 0)
	g.AllowPrivateFetch = envBool("SRR_ALLOW_PRIVATE_FETCH", false)
	g.floorScoped()
}

// env seed helpers: a set-and-nonempty env var wins when it parses; a
// malformed value warns and keeps the default (the seeded command asked
// nothing of the knob — kong still hard-errors where the flag is declared).
func envStr(name, def string) string {
	if v, ok := os.LookupEnv(name); ok && v != "" {
		return v
	}
	return def
}

func envInt(name string, def int) int {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		slog.Warn("malformed env value; using default", "var", name, "value", v, "default", def)
		return def
	}
	return n
}

func envDur(name string, def time.Duration) time.Duration {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		slog.Warn("malformed env value; using default", "var", name, "value", v, "default", def)
		return def
	}
	return d
}

func envBool(name string, def bool) bool {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		slog.Warn("malformed env value; using default", "var", name, "value", v, "default", def)
		return def
	}
	return b
}
