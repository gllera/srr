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
	"gopkg.in/yaml.v3"
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
	Workers int    `short:"w" default:"${nproc}" env:"SRR_WORKERS" help:"Number of concurrent downloads."`
	Store   string `short:"o" default:"packs" env:"SRR_STORE" help:"Storage destination path, or a name from srr.yaml's 'stores:' alias map."`
	Force   bool   `env:"SRR_FORCE" help:"Override DB write lock if needed."`
	Debug   bool   `short:"d" env:"SRR_DEBUG" help:"Enable debug mode."`
	CdnURL  string `hidden:"" env:"SRR_CDN_URL" help:"CDN URL for frontend builds."`

	// Scoped knobs — no longer global flags (kong:"-"). Their kong
	// declarations live on the shared structs in flags.go, embedded by the
	// commands that read them (fetch, serve, mcp, store compact, preview,
	// feed add/upd/import, config); every other command runs on
	// seedScopedDefaults' default+env seeds. This struct stays the single
	// runtime carrier so db_pack.go / notify.go / the mod applies are
	// untouched, and `srr config` keeps printing every knob.
	PackSize            int           `kong:"-"`
	MaxFeedSize         int           `kong:"-"`
	MaxAssetSize        int           `kong:"-"`
	AssetProcess        string        `kong:"-"`
	AssetPeek           string        `kong:"-"`
	AssetWorkers        int           `kong:"-"`
	AssetProcessTimeout time.Duration `kong:"-"`
	CacheDir            string        `kong:"-"`
	CacheMaxAge         time.Duration `kong:"-"`
	FetchBackoffMax     time.Duration `kong:"-"`
	MaxDeltas           int           `kong:"-"`
	MaxDeltaBytes       int           `kong:"-"`
	MaxBatchBytes       int           `kong:"-"`
	KeepManifests       int           `kong:"-"`
	CmdTimeout          time.Duration `kong:"-"`
	AllowPrivateFetch   bool          `kong:"-"`
	Notify              string        `kong:"-"`
	NotifyAfter         int           `kong:"-"`
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
	Watch     WatchGroup     `cmd:"" help:"Manage keyword watchlists (named per-article match rules)."`
	Export    ExportAllCmd   `cmd:"" help:"Write the whole store configuration (feeds, recipes, syndication, dedup default) as JSON."`
	Import    ImportAllCmd   `cmd:"" help:"Restore a configuration written by 'srr export' (feeds matched by url; fetch state untouched)."`
	Dedup     DedupCmd       `cmd:"" help:"Print or set the store-wide default dedup horizon (db.gz 'dd', in days)."`
	Compact   CompactCmd     `cmd:"" help:"Physically reclaim the payload bytes of already-expired articles (opt-in; the one op that removes bytes)."`
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

// scopedYAMLFlags routes the flags whose kong declarations moved off Globals
// (flags.go) to their bare TOP-LEVEL srr.yaml key. kong-yaml resolves a flag
// at its command path ("fetch-pack-size"), which would orphan the top-level
// keys existing config files use; this set restores those — and ONLY those,
// so a stray top-level "interval:" or "tag:" can never be captured by a
// per-command flag.
var scopedYAMLFlags = func() map[string]bool {
	m := map[string]bool{}
	for _, n := range scopedFlagNamesList {
		m[n] = true
	}
	return m
}()

// configResolver wraps the kong-yaml resolver with the two SRR-specific rules:
// (1) an explicitly-set, non-empty SRR_* env var wins over the config file,
// restoring the documented precedence (CLI flag > env var > config file >
// default) — kong applies a flag's env: tag during Reset but does not record
// the value as "already set", so a later-running config resolver would
// otherwise silently override an SRR_*-provided value, e.g. a stale `store:`
// in srr.yaml beating SRR_STORE (CLI flags are unaffected: kong records those
// before resolvers run); (2) the scoped flags resolve from their bare
// top-level yaml key at any command depth.
func configResolver(inner kong.Resolver, root map[string]any) kong.Resolver {
	return kong.ResolverFunc(func(ctx *kong.Context, parent *kong.Path, flag *kong.Flag) (any, error) {
		for _, env := range flag.Tag.Envs {
			// A set-but-empty env var is treated as unset (matching the
			// SRR_CONFIG_INLINE convention) so a blank SRR_* doesn't suppress the
			// YAML/default value and leave the flag empty.
			if v, ok := os.LookupEnv(env); ok && v != "" {
				return nil, nil
			}
		}
		if scopedYAMLFlags[flag.Name] {
			return root[flag.Name], nil // nil when absent → the kong default applies
		}
		return inner.Resolve(ctx, parent, flag)
	})
}

// kongOptions is the single source of the CLI's kong configuration; the
// parser-model tests build the same tree main() parses. resolver may be nil
// (tests that don't exercise config resolution).
func kongOptions(resolver kong.Resolver) []kong.Option {
	opts := []kong.Option{
		kong.Vars{
			"nproc":         fmt.Sprint(runtime.NumCPU()),
			"packSize":      fmt.Sprint(defaultPackSize),
			"maxFeedSize":   fmt.Sprint(defaultMaxFeedSize),
			"maxAssetSize":  fmt.Sprint(defaultMaxAssetSize),
			"maxDeltas":     fmt.Sprint(maxDeltasDefault),
			"maxDeltaBytes": fmt.Sprint(maxDeltaBytesDefault),
			"maxBatchBytes": fmt.Sprint(maxBatchBytesDefault),
			"keepManifests": fmt.Sprint(keepManifests),
			"cacheDir":      defaultCacheDir(),
			"syncDir":       defaultSyncDir(),
		},
		kong.Name("srr"),
		kong.Description("Static RSS Reader backend."),
		kong.ShortUsageOnError(),
		kong.ConfigureHelp(kong.HelpOptions{
			Compact:             true,
			FlagsLast:           true,
			NoExpandSubcommands: true,
		}),
	}
	if resolver != nil {
		opts = append(opts, kong.Resolvers(resolver))
	}
	return opts
}

func main() {
	// Route all slog output (the default handler writes via the log package)
	// through the terminal status line, so a log record and the in-place fetch
	// stats line never garble each other. Pure passthrough when stderr isn't a
	// tty or no status is drawn.
	log.SetOutput(status)

	var cli CLI
	globals = &cli.Globals
	// Seed the scoped knobs (compiled default + SRR_* env) BEFORE Parse:
	// commands embedding the flag structs overwrite these via AfterApply with
	// fully-resolved values; the rest never run on Go zero values (flags.go).
	seedScopedDefaults(globals)

	configData, err := readConfig()
	if err != nil {
		fatal(err.Error())
	}

	resolver, err := kongyaml.Loader(bytes.NewReader(configData))
	if err != nil {
		fatal("parsing config", "err", err)
	}

	// The raw top-level document, for the scoped-flag clause in configResolver
	// and the `stores:` alias map.
	var rootCfg map[string]any
	if err := yaml.Unmarshal(configData, &rootCfg); err != nil {
		fatal("parsing config", "err", err)
	}

	ctx := kong.Parse(&cli, kongOptions(configResolver(resolver, rootCfg))...)

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

	if globals.Workers < 1 {
		globals.Workers = runtime.NumCPU()
	}
	// The scoped-knob floors (PackSize/MaxAssetSize/CacheDir/KeepManifests/…)
	// live in Globals.floorScoped (flags.go), run by the seed and by every
	// flag struct's AfterApply.

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
