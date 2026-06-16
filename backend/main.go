package main

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"srrb/store"

	"github.com/alecthomas/kong"
	kongyaml "github.com/alecthomas/kong-yaml"
)

var version = "development"
var globals *Globals

type Globals struct {
	Workers      int    `short:"w" default:"${nproc}" env:"SRR_WORKERS"       help:"Number of concurrent downloads."`
	PackSize     int    `short:"s" default:"200"      env:"SRR_PACK_SIZE"     help:"Target pack size in KB."`
	MaxFeedSize  int    `short:"m" default:"5000"     env:"SRR_MAX_FEED_SIZE" help:"Max feed download size in KB."`
	MaxMediaSize int    `          default:"25000"    env:"SRR_MAX_MEDIA_SIZE" help:"Max self-hosted media object size in KB."`
	AssetFilter  string `                             env:"SRR_ASSET_FILTER" help:"Command run on every self-hosted asset just before upload to process its bytes, e.g. transcode media (the cache file path is appended as the final arg; processed bytes are read from stdout; non-zero exit or empty output keeps the original). Skipped when the source is already uploaded. Empty disables. E.g. \"webify -m 720\"."`
	CacheDir     string `                             env:"SRR_CACHE_DIR"     help:"Local download cache for external ingest media (default $XDG_CACHE_HOME/srr)."`
	Store        string `short:"o" default:"packs"    env:"SRR_STORE"         help:"Storage destination path."`
	Force        bool   `                             env:"SRR_FORCE"         help:"Override DB write lock if needed."`
	Debug        bool   `short:"d"                    env:"SRR_DEBUG"         help:"Enable debug mode."`
	CdnURL       string `hidden:""                    env:"SRR_CDN_URL"       help:"CDN URL for frontend builds."`
}

type ChannelGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to a new RSS channel."`
	Upd    UpdCmd    `cmd:"" help:"Update an existing channel."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from channel(s)."`
	Ls     LsCmd     `cmd:"" help:"List channels."`
	Show   ShowCmd   `cmd:"" help:"Print one channel's record."`
	Edit   EditCmd   `cmd:"" help:"Open a channel record in $EDITOR and apply on save."`
	Apply  ApplyCmd  `cmd:"" help:"Upsert channels from JSON (object or array)."`
	Import ImportCmd `cmd:"" help:"Import opml channels file."`
	Export ExportCmd `cmd:"" help:"Export channels as OPML (inverse of import)."`
}

type ArtGroup struct {
	Fetch FetchCmd `cmd:"" help:"Fetch channel articles."`
	Ls    ArtCmd   `cmd:"" help:"List stored articles."`
}

type CLI struct {
	Globals
	Chan    ChannelGroup `cmd:"" aliases:"ch" help:"Channel management."`
	Art     ArtGroup     `cmd:"" aliases:"a" help:"Article management."`
	Pipe    PipeCmd      `cmd:"" help:"Set or print root pipe (default pipeline inherited by channels)."`
	Ingest  IngestCmd    `cmd:"" help:"Set or print root ingest strategy (default inherited by channels)."`
	Gen     GenCmd       `cmd:"" help:"Print or bump the store generation (db.gz 'gen'; frontend SW cache key)."`
	Preview PreviewCmd   `cmd:"" aliases:"p" help:"Preview processed feed articles in a browser."`
	Config  ConfigCmd    `cmd:"" aliases:"c" help:"Print resolved configuration."`
	Inspect InspectCmd   `cmd:"" aliases:"i" help:"Inspect pack consistency (validate idx<->data, debug chronIdx lookup)."`
	GenTS   GenTSCmd     `cmd:"" name:"gen-ts" hidden:"" help:"Generate frontend/src/js/format.gen.ts from the Go data-contract declarations."`
	Version VersionCmd   `cmd:"" help:"Print version information."`
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

// assetCacheRoot resolves the parent dir under which external ingest strategies
// get a persistent per-feed media download cache. Precedence:
// --cache-dir/SRR_CACHE_DIR → os.UserCacheDir()/srr (i.e. $XDG_CACHE_HOME or
// ~/.cache) → $TMPDIR/srr. Always non-empty so the feature stays on by default;
// the cache is disposable (the store remains the source of truth), so a
// less-ideal location only costs re-downloads.
func assetCacheRoot() string {
	if globals.CacheDir != "" {
		return globals.CacheDir
	}
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
			if _, ok := os.LookupEnv(env); ok {
				return nil, nil
			}
		}
		return inner.Resolve(ctx, parent, flag)
	})
}

func main() {
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
			"nproc": fmt.Sprint(runtime.NumCPU()),
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

	if globals.Debug {
		slog.SetLogLoggerLevel(slog.LevelDebug)
	}

	if globals.Store == "" {
		fatal("store path is required")
	}

	if globals.PackSize < 1 {
		globals.PackSize = 200
	}

	if globals.MaxFeedSize < 1 {
		globals.MaxFeedSize = 5000
	}

	// Floor like the other size globals: a value <= 0 would make the asset
	// fetcher's maxBytes <= 0, which disables every size-cap guard and lets an
	// attacker-controlled response stream unbounded into memory/the store.
	if globals.MaxMediaSize < 1 {
		globals.MaxMediaSize = 25000
	}

	if globals.Workers < 1 {
		globals.Workers = runtime.NumCPU()
	}

	if err := ctx.Run(); err != nil {
		fatal(err.Error())
	}
}
