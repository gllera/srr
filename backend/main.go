package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"github.com/alecthomas/kong"
	kongyaml "github.com/alecthomas/kong-yaml"
	"github.com/gllera/srr/backend/store"
)

var version = "development"
var globals *Globals

type Globals struct {
	Workers     int    `short:"w" default:"${nproc}" env:"SRR_WORKERS"       help:"Number of concurrent downloads."`
	PackSize    int    `short:"s" default:"200"      env:"SRR_PACK_SIZE"     help:"Target pack size in KB."`
	MaxFeedSize int    `short:"m" default:"5000"     env:"SRR_MAX_FEED_SIZE" help:"Max feed download size in KB."`
	Store       string `short:"o" default:"packs"    env:"SRR_STORE"         help:"Storage destination path."`
	Force       bool   `                             env:"SRR_FORCE"         help:"Override DB write lock if needed."`
	Debug       bool   `short:"d"                    env:"SRR_DEBUG"         help:"Enable debug mode."`
}

type CLI struct {
	Globals
	Add     AddCmd     `cmd:"" help:"Subscribe to RSS or update an existing subscription."`
	Rm      RmCmd      `cmd:"" help:"Unsubscribe from RSS(s)."`
	Ls      LsCmd      `cmd:"" help:"List subscriptions."`
	Fetch   FetchCmd   `cmd:"" help:"Fetch subscriptions articles."`
	Import  ImportCmd  `cmd:"" help:"Import opml subscriptions file."`
	Preview PreviewCmd `cmd:"" help:"Preview processed feed articles in a browser."`
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

func main() {
	var cli CLI
	globals = &cli.Globals

	configDir := os.Getenv("XDG_CONFIG_HOME")
	if configDir == "" {
		home, _ := os.UserHomeDir()
		configDir = filepath.Join(home, ".config")
	}
	configPath := os.Getenv("SRR_CONFIG")
	if configPath == "" {
		configPath = filepath.Join(configDir, "srr", "srr.yaml")
	}

	ctx := kong.Parse(&cli,
		kong.Vars{
			"nproc": fmt.Sprint(runtime.NumCPU()),
		},
		kong.Name("srr"),
		kong.Description("Static RSS Reader backend."),
		kong.Configuration(kongyaml.Loader, configPath),
		kong.ShortUsageOnError(),
		kong.ConfigureHelp(kong.HelpOptions{
			Compact:             true,
			FlagsLast:           true,
			NoExpandSubcommands: true,
		}),
	)

	if err := store.LoadConfigs(configPath); err != nil {
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
