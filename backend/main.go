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
	Workers     int    `short:"w" default:"${nproc}" env:"SRR_WORKERS"       help:"Number of concurrent downloads."`
	PackSize    int    `short:"s" default:"200"      env:"SRR_PACK_SIZE"     help:"Target pack size in KB."`
	MaxFeedSize int    `short:"m" default:"5000"     env:"SRR_MAX_FEED_SIZE" help:"Max feed download size in KB."`
	Store       string `short:"o" default:"packs"    env:"SRR_STORE"         help:"Storage destination path."`
	Cache       string `short:"c"                    env:"SRR_CACHE"         help:"Local cache directory for remote stores."`
	Force       bool   `                             env:"SRR_FORCE"         help:"Override DB write lock if needed."`
	Debug       bool   `short:"d"                    env:"SRR_DEBUG"         help:"Enable debug mode."`
	CdnURL      string `hidden:""                    env:"SRR_CDN_URL"       help:"CDN URL for frontend builds."`
}

type SubGroup struct {
	Add    AddCmd    `cmd:"" help:"Subscribe to RSS or update an existing subscription."`
	Rm     RmCmd     `cmd:"" help:"Unsubscribe from RSS(s)."`
	Ls     LsCmd     `cmd:"" help:"List subscriptions."`
	Import ImportCmd `cmd:"" help:"Import opml subscriptions file."`
}

type ArtGroup struct {
	Fetch FetchCmd `cmd:"" help:"Fetch subscriptions articles."`
	Ls    ArtCmd   `cmd:"" help:"List stored articles."`
}

type CLI struct {
	Globals
	Sub     SubGroup   `cmd:"" aliases:"s" help:"Subscription management."`
	Art     ArtGroup   `cmd:"" aliases:"a" help:"Article management."`
	Preview PreviewCmd `cmd:"" aliases:"p" help:"Preview processed feed articles in a browser."`
	Config  ConfigCmd  `cmd:"" aliases:"c" help:"Print resolved configuration."`
	Inspect InspectCmd `cmd:"" aliases:"i" help:"Inspect pack consistency (validate idx<->data, debug chronIdx lookup)."`
	Version VersionCmd `cmd:"" help:"Print version information."`
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
		kong.Resolvers(resolver),
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

	if globals.Workers < 1 {
		globals.Workers = runtime.NumCPU()
	}

	if err := ctx.Run(); err != nil {
		fatal(err.Error())
	}
}
