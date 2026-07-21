package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"srr/ingest"
	"srr/mod"
	"srr/store"

	"github.com/alecthomas/kong"
	kongyaml "github.com/alecthomas/kong-yaml"
)

var version = "development"
var globals *Globals

// Size-global defaults, single-sourced: each is fed to kong as a default via
// kong.Vars (so it shows in --help) AND used as the post-parse floor below, so
// the literal lives in exactly one place per field.
const (
	defaultPackSize     = 200
	defaultMaxFeedSize  = 5000
	defaultMaxAssetSize = 25000
)

type Globals struct {
	Workers             int           `short:"w" default:"${nproc}" env:"SRR_WORKERS"       help:"Number of concurrent downloads."`
	PackSize            int           `short:"s" default:"${packSize}"      env:"SRR_PACK_SIZE"     help:"Target pack size in KB."`
	MaxFeedSize         int           `short:"m" default:"${maxFeedSize}"     env:"SRR_MAX_FEED_SIZE" help:"Max feed download size in KB."`
	MaxAssetSize        int           `          default:"${maxAssetSize}"    env:"SRR_MAX_ASSET_SIZE" help:"Max self-hosted asset object size in KB."`
	AssetProcess        string        `                             env:"SRR_ASSET_PROCESS" help:"Command run on every self-hosted asset just before upload to process its bytes, e.g. transcode media. The cache file path is substituted for each {input} token, or appended as the final arg when absent. With a {output} token the command writes its result to that file and prints a {mimetype,extension,encoding} JSON to stdout (setting the stored Content-Type/-Encoding); without {output}, processed bytes are read from stdout. Non-zero exit or empty output keeps the original. Skipped when the source is already uploaded. Empty disables. E.g. \"webify -m 720\" or \"conv -i {input} -o {output}\"."`
	AssetPeek           string        `                             env:"SRR_ASSET_PEEK" help:"Command run on every self-hosted asset (before the dedup check) to identify it: it receives the cache file path (substituted for each {input} token, or appended) and prints a {mimetype,extension,supported} JSON to stdout. The extension sets the stored object's key/extension (so a transcoded asset carries its true output extension) and mimetype its Content-Type; supported=false hosts the original bytes and skips asset-process. A non-zero exit or invalid JSON falls back to the source extension. Empty disables. E.g. \"identify-asset {input}\"."`
	AssetWorkers        int           `                             env:"SRR_ASSET_WORKERS" default:"${nproc}" help:"Max assets processed concurrently across all feeds (peek/transcode/upload). Independent of --workers."`
	AssetProcessTimeout time.Duration `        env:"SRR_ASSET_PROCESS_TIMEOUT" default:"0" help:"Timeout for a single asset-process or asset-peek command invocation (Go duration). 0 (the default) means unlimited — no deadline, since media transcoding can run arbitrarily long; the command is still bounded by run cancellation (SIGINT/SIGTERM). The shared --cmd-timeout governs ingest/mod commands only and never affects asset processing."`
	CacheDir            string        `default:"${cacheDir}"        env:"SRR_CACHE_DIR"     help:"Local download cache for external ingest media."`
	CacheMaxAge         time.Duration `                             env:"SRR_CACHE_MAX_AGE" default:"72h" help:"Delete ingest-cache files unused for longer than this, swept after each fetch cycle. Downloads are consumed (uploaded to the store) within their cycle, and cache reuse refreshes a file's mtime, so old files are garbage. 0 disables the sweep."`
	Store               string        `short:"o" default:"packs"    env:"SRR_STORE"         help:"Storage destination path."`
	Force               bool          `                             env:"SRR_FORCE"         help:"Override DB write lock if needed."`
	Debug               bool          `short:"d"                    env:"SRR_DEBUG"         help:"Enable debug mode."`
	// CmdTimeout / AllowPrivateFetch were previously env-only (read straight from
	// os.Getenv in mod/); promoted to real flags so they show in --help and
	// `srr config`. main applies them into the mod package after parse.
	FetchBackoffMax   time.Duration `default:"1h" env:"SRR_FETCH_BACKOFF_MAX" help:"Loop-only: cap the adaptive per-feed poll interval a dormant feed drifts to (grows as time-since-last-new/8 from --interval). 0 disables backoff (poll every feed every cycle)."`
	MaxDeltas         int           `default:"${maxDeltas}" env:"SRR_MAX_DELTAS" help:"Max delta segments (data/d<g>.gz, one per article-producing cycle) before a cycle consolidates them into the tail packs. Bounds a cold reader's extra requests. 0 disables deltas: every dirty cycle rewrites the tail packs (the pre-delta behavior)."`
	MaxDeltaBytes     int           `default:"${maxDeltaBytes}" env:"SRR_MAX_DELTA_BYTES" help:"Consolidate the tail once the live delta segments hold more than this many KB of uncompressed article JSONL (bounds a cold reader's delta payload)."`
	CmdTimeout        time.Duration `default:"5m" env:"SRR_CMD_TIMEOUT" help:"Timeout for a single external ingest/mod command (Go duration)."`
	AllowPrivateFetch bool          `env:"SRR_ALLOW_PRIVATE_FETCH" help:"Disable the SSRF guard, allowing fetches from private/loopback addresses. Security override — leave off unless you fetch LAN/localhost feeds."`
	CdnURL            string        `hidden:"" env:"SRR_CDN_URL" help:"CDN URL for frontend builds."`
	// Notify / NotifyAfter are the feed-health alerting hook: fail_streak has
	// always been recorded but nothing watched it. Context reaches the command
	// through SRR_NOTIFY_* env vars, never string interpolation (feed titles and
	// error text are attacker-influenced).
	Notify      string `env:"SRR_NOTIFY" help:"Shell command run when a feed crosses --notify-after consecutive failures, and again when it recovers. Context arrives as SRR_NOTIFY_EVENT (fail|recover), _FEED, _FEED_ID, _URL, _ERROR, _STREAK. Empty (default) disables alerting."`
	NotifyAfter int    `default:"5" env:"SRR_NOTIFY_AFTER" help:"Consecutive failures before --notify fires (the crossing alerts once per outage)."`
}

type FeedGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to a new RSS feed."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing feed."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from feed(s)."`
	Ls     LsCmd     `cmd:"" help:"List feeds."`
	Show   ShowCmd   `cmd:"" help:"Print one feed's record."`
	Edit   EditCmd   `cmd:"" help:"Open a feed record in $EDITOR and apply on save."`
	Apply  ApplyCmd  `cmd:"" help:"Upsert feeds from JSON (object or array)."`
	Import ImportCmd `cmd:"" help:"Import opml feeds file."`
	Export ExportCmd `cmd:"" help:"Export feeds as OPML (inverse of import)."`
}

type ArtGroup struct {
	Fetch FetchCmd `cmd:"" help:"Fetch feed articles."`
	Ls    ArtCmd   `cmd:"" help:"List stored articles."`
}

type CLI struct {
	Globals
	Feed      FeedGroup      `cmd:"" aliases:"f" help:"Feed management."`
	Art       ArtGroup       `cmd:"" aliases:"a" help:"Article management."`
	Asset     AssetGroup     `cmd:"" help:"Self-hosted asset tooling (repair a published object)."`
	Syndicate SyndicateGroup `cmd:"" help:"Manage syndication output feeds (out/*)."`
	Recipe    RecipeGroup    `cmd:"" help:"Manage processing recipes (named {ingest, pipe} bundles)."`
	Export    ExportAllCmd   `cmd:"" help:"Write the whole store configuration (feeds, recipes, syndication, dedup default) as JSON."`
	Import    ImportAllCmd   `cmd:"" help:"Restore a configuration written by 'srr export' (feeds matched by url; fetch state untouched)."`
	Gen       GenCmd         `cmd:"" help:"Print or bump the store generation (db.gz 'gen'; frontend SW cache key)."`
	Dedup     DedupCmd       `cmd:"" help:"Print or set the store-wide default dedup horizon (db.gz 'dd', in days)."`
	Preview   PreviewCmd     `cmd:"" aliases:"p" help:"Preview processed feed articles in a browser."`
	Serve     ServeCmd       `cmd:"" help:"Serve a local web admin GUI for managing feeds, recipes, syndication."`
	Mcp       McpCmd         `cmd:"" help:"Serve the SRR MCP tool interface over stdio."`
	Frontend  FrontendGroup  `cmd:"" aliases:"fe" help:"Manage the self-hosted reader frontend in the store root."`
	Config    ConfigCmd      `cmd:"" aliases:"c" help:"Print resolved configuration."`
	Inspect   InspectCmd     `cmd:"" aliases:"i" help:"Inspect pack consistency (validate idx<->data, debug chronIdx lookup)."`
	GenTS     GenTSCmd       `cmd:"" name:"gen-ts" hidden:"" help:"Generate frontend/src/js/format.gen.ts from the Go data-contract declarations."`
	Version   VersionCmd     `cmd:"" help:"Print version information."`
}

type VersionCmd struct{}

func (o *VersionCmd) Run() error {
	fmt.Println("Version:", version)
	return nil
}

func fatal(msg string, attr ...any) {
	slog.Error(msg, attr...)
	os.Exit(1)
}

// readConfig returns YAML config bytes from $SRR_CONFIG_INLINE if set, otherwise
// reads the file at $SRR_CONFIG (default $XDG_CONFIG_HOME/srr/srr.yaml).
// A missing file yields empty bytes, not an error.
func readConfig() ([]byte, error) {
	if conf := os.Getenv("SRR_CONFIG_INLINE"); conf != "" {
		return []byte(conf), nil
	}

	configPath := os.Getenv("SRR_CONFIG")
	if configPath == "" {
		configDir := os.Getenv("XDG_CONFIG_HOME")
		if configDir == "" {
			home, _ := os.UserHomeDir()
			configDir = filepath.Join(home, ".config")
		}
		configPath = filepath.Join(configDir, "srr", "srr.yaml")
	}

	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading config %s: %w", configPath, err)
	}
	return data, nil
}

// defaultCacheDir computes the fallback ingest-media cache location used when
// --cache-dir/SRR_CACHE_DIR is unset: os.UserCacheDir()/srr (i.e. $XDG_CACHE_HOME
// or ~/.cache) → $TMPDIR/srr. Always non-empty. Registered as the kong ${cacheDir}
// var so this resolved path becomes the CacheDir flag default — visible in --help
// and `srr config` — and re-applied as the post-parse floor in main(), so
// globals.CacheDir is ALWAYS set (an explicitly empty `cache-dir:` in YAML would
// otherwise slip past the kong default). The cache is disposable (the store
// remains the source of truth), so a less-ideal location only costs re-downloads.
func defaultCacheDir() string {
	if dir, err := os.UserCacheDir(); err == nil {
		return filepath.Join(dir, "srr")
	}
	return filepath.Join(os.TempDir(), "srr")
}

// envFirstResolver wraps the YAML config resolver so an explicitly-set
// environment variable wins over the config file, restoring the documented
// precedence (CLI flag > env var > config file > default). kong applies a
// flag's env: tag during Reset but does not record the value as "already set",
// so a later-running config resolver would otherwise silently override an
// SRR_*-provided value — e.g. a stale `store:` in srr.yaml beating SRR_STORE.
// CLI flags are unaffected: kong records those before resolvers run.
func envFirstResolver(inner kong.Resolver) kong.Resolver {
	return kong.ResolverFunc(func(ctx *kong.Context, parent *kong.Path, flag *kong.Flag) (any, error) {
		for _, env := range flag.Tag.Envs {
			// A set-but-empty env var is treated as unset (matching the
			// SRR_CONFIG_INLINE convention) so a blank SRR_* doesn't suppress the
			// YAML/default value and leave the flag empty.
			if v, ok := os.LookupEnv(env); ok && v != "" {
				return nil, nil
			}
		}
		return inner.Resolve(ctx, parent, flag)
	})
}

func main() {
	// Route all slog output (the default handler writes via the log package)
	// through the terminal status line, so a log record and the in-place fetch
	// stats line never garble each other. Pure passthrough when stderr isn't a
	// tty or no status is drawn.
	log.SetOutput(status)

	var cli CLI
	globals = &cli.Globals

	configData, err := readConfig()
	if err != nil {
		fatal(err.Error())
	}

	resolver, err := kongyaml.Loader(bytes.NewReader(configData))
	if err != nil {
		fatal("parsing config", "err", err)
	}

	ctx := kong.Parse(&cli,
		kong.Vars{
			"nproc":         fmt.Sprint(runtime.NumCPU()),
			"packSize":      fmt.Sprint(defaultPackSize),
			"maxFeedSize":   fmt.Sprint(defaultMaxFeedSize),
			"maxAssetSize":  fmt.Sprint(defaultMaxAssetSize),
			"maxDeltas":     fmt.Sprint(maxDeltasDefault),
			"maxDeltaBytes": fmt.Sprint(maxDeltaBytesDefault),
			"cacheDir":      defaultCacheDir(),
		},
		kong.Name("srr"),
		kong.Description("Static RSS Reader backend."),
		kong.Resolvers(envFirstResolver(resolver)),
		kong.ShortUsageOnError(),
		kong.ConfigureHelp(kong.HelpOptions{
			Compact:             true,
			FlagsLast:           true,
			NoExpandSubcommands: true,
		}),
	)

	if err := store.LoadConfigs(configData); err != nil {
		fatal("loading backend configs", "err", err)
	}

	if secrets, err = parseSecrets(configData); err != nil {
		fatal("loading secrets", "err", err)
	}

	if globals.Debug {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	if globals.Store == "" {
		fatal("store path is required")
	}

	if globals.PackSize < 1 {
		globals.PackSize = defaultPackSize
	}

	if globals.MaxFeedSize < 1 {
		globals.MaxFeedSize = defaultMaxFeedSize
	}

	// Floor like the other size globals: a value <= 0 would make the asset
	// fetcher's maxBytes <= 0, which disables every size-cap guard and lets an
	// attacker-controlled response stream unbounded into memory/the store.
	if globals.MaxAssetSize < 1 {
		globals.MaxAssetSize = defaultMaxAssetSize
	}

	if globals.Workers < 1 {
		globals.Workers = runtime.NumCPU()
	}

	// CacheDir is guaranteed non-empty from here on (the fetch path uses it
	// directly, no per-site fallback): the kong ${cacheDir} default covers the
	// unset case, this floor the explicitly-empty one (`cache-dir: ""` in YAML).
	if globals.CacheDir == "" {
		globals.CacheDir = defaultCacheDir()
	}

	if globals.AssetWorkers < 1 {
		globals.AssetWorkers = runtime.NumCPU()
	}

	// Identify this build to feed publishers: "SRR/<version> (+repo)" is the
	// shape feed readers are expected to send, and the version is the same one
	// `srr version` prints.
	ingest.SetUserAgent("SRR/" + version + " (+https://github.com/gllera/srr)")

	// Apply the resolved config into the mod package (its external-command
	// timeout + SSRF opt-out were formerly read straight from the environment).
	mod.CmdTimeout = globals.CmdTimeout
	mod.AllowPrivateFetch = globals.AllowPrivateFetch
	// #selfhost enforces the asset size cap at download (KB → bytes).
	mod.MaxAssetSize = int64(globals.MaxAssetSize) * (1 << 10)
	// srr.yaml `secrets:` merged into external ingest/mod command environments.
	mod.SetSecrets(secrets)

	if err := ctx.Run(); err != nil {
		slog.Error(err.Error())
		os.Exit(exitCodeFor(err))
	}
}

// Exit codes. A cron health check must be able to tell "the store is broken"
// from "someone else holds the lock" from "I could not read the store" without
// scraping the message — kong already owns 1 for usage errors, so the classes
// start above it.
const (
	exitGeneric    = 1 // anything unclassified (also kong's usage-error code)
	exitLocked     = 3 // another process (or in-process writer) holds the store
	exitValidation = 4 // srr inspect --validate found store inconsistencies
	exitStoreIO    = 5 // the store could not be read/written
)

func exitCodeFor(err error) int {
	switch {
	case errors.Is(err, os.ErrExist):
		return exitLocked
	case errors.Is(err, errValidation):
		return exitValidation
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, fs.ErrPermission):
		return exitStoreIO
	}
	return exitGeneric
}
