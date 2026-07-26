package main

import (
	"runtime"
	"testing"
	"time"

	"github.com/alecthomas/kong"
)

// resetGlobals swaps in a fresh runtime carrier and restores the old one.
func resetGlobals(t *testing.T) *Globals {
	t.Helper()
	saved := globals
	globals = &Globals{}
	t.Cleanup(func() { globals = saved })
	return globals
}

// seedScopedDefaults must fill every scoped knob with compiled default or
// SRR_* env override — never leave a Go zero value (the feed-rm delta-drain
// guard: RemoveFeed can reach the pack writer without any flag struct
// embedded, and a zero PackSize would roll a pack per line).
func TestSeedScopedDefaults(t *testing.T) {
	t.Run("defaults_when_env_unset", func(t *testing.T) {
		g := resetGlobals(t)
		t.Setenv("SRR_PACK_SIZE", "")
		t.Setenv("SRR_CACHE_MAX_AGE", "")
		t.Setenv("SRR_ALLOW_PRIVATE_FETCH", "")
		seedScopedDefaults(g)
		if g.PackSize != defaultPackSize {
			t.Errorf("PackSize = %d, want %d", g.PackSize, defaultPackSize)
		}
		if g.MaxDeltas != maxDeltasDefault {
			t.Errorf("MaxDeltas = %d, want %d", g.MaxDeltas, maxDeltasDefault)
		}
		if g.KeepManifests != keepManifests {
			t.Errorf("KeepManifests = %d, want %d", g.KeepManifests, keepManifests)
		}
		if g.CacheMaxAge != 72*time.Hour {
			t.Errorf("CacheMaxAge = %v, want 72h", g.CacheMaxAge)
		}
		if g.CmdTimeout != 5*time.Minute {
			t.Errorf("CmdTimeout = %v, want 5m", g.CmdTimeout)
		}
		if g.AssetWorkers != runtime.NumCPU() {
			t.Errorf("AssetWorkers = %d, want nproc", g.AssetWorkers)
		}
		if g.CacheDir == "" {
			t.Error("CacheDir must never seed empty")
		}
		if g.NotifyAfter != 5 {
			t.Errorf("NotifyAfter = %d, want 5", g.NotifyAfter)
		}
	})

	t.Run("env_overrides", func(t *testing.T) {
		g := resetGlobals(t)
		t.Setenv("SRR_PACK_SIZE", "7")
		t.Setenv("SRR_CACHE_MAX_AGE", "1h")
		t.Setenv("SRR_ALLOW_PRIVATE_FETCH", "true")
		t.Setenv("SRR_NOTIFY", "notify-send")
		seedScopedDefaults(g)
		if g.PackSize != 7 {
			t.Errorf("PackSize = %d, want 7 (env)", g.PackSize)
		}
		if g.CacheMaxAge != time.Hour {
			t.Errorf("CacheMaxAge = %v, want 1h (env)", g.CacheMaxAge)
		}
		if !g.AllowPrivateFetch {
			t.Error("AllowPrivateFetch = false, want true (env)")
		}
		if g.Notify != "notify-send" {
			t.Errorf("Notify = %q, want notify-send (env)", g.Notify)
		}
	})

	t.Run("malformed_env_keeps_default", func(t *testing.T) {
		g := resetGlobals(t)
		t.Setenv("SRR_PACK_SIZE", "banana")
		t.Setenv("SRR_CMD_TIMEOUT", "not-a-duration")
		seedScopedDefaults(g)
		if g.PackSize != defaultPackSize {
			t.Errorf("PackSize = %d, want default on malformed env", g.PackSize)
		}
		if g.CmdTimeout != 5*time.Minute {
			t.Errorf("CmdTimeout = %v, want default on malformed env", g.CmdTimeout)
		}
	})

	t.Run("zero_env_is_floored", func(t *testing.T) {
		// SRR_PACK_SIZE=0 must not smuggle a zero past the seed (the writer
		// would roll a pack per line during a feed-rm drain).
		g := resetGlobals(t)
		t.Setenv("SRR_PACK_SIZE", "0")
		seedScopedDefaults(g)
		if g.PackSize != defaultPackSize {
			t.Errorf("PackSize = %d, want floor %d", g.PackSize, defaultPackSize)
		}
	})
}

// The AfterApply hooks copy kong-resolved values into globals and floor them —
// the same floors main() used to run post-parse.
func TestFlagStructsApply(t *testing.T) {
	t.Run("cycle_copies_and_floors", func(t *testing.T) {
		g := resetGlobals(t)
		f := cycleFlags{PackSize: 33, MaxDeltas: 4, CacheDir: "/tmp/x", AssetWorkers: 2,
			MaxAssetSize: 100, CacheMaxAge: time.Hour, NotifyAfter: 9}
		if err := f.AfterApply(); err != nil {
			t.Fatal(err)
		}
		if g.PackSize != 33 || g.MaxDeltas != 4 || g.NotifyAfter != 9 {
			t.Errorf("copy failed: PackSize=%d MaxDeltas=%d NotifyAfter=%d", g.PackSize, g.MaxDeltas, g.NotifyAfter)
		}
		zero := cycleFlags{} // all zero → every floor fires
		if err := zero.AfterApply(); err != nil {
			t.Fatal(err)
		}
		if g.PackSize != defaultPackSize || g.MaxAssetSize != defaultMaxAssetSize ||
			g.AssetWorkers != runtime.NumCPU() || g.CacheDir == "" {
			t.Errorf("floors failed: %+v", *g)
		}
	})

	t.Run("gc_raises_to_contract_floor", func(t *testing.T) {
		g := resetGlobals(t)
		f := gcFlags{KeepManifests: 1}
		if err := f.AfterApply(); err != nil {
			t.Fatal(err)
		}
		if g.KeepManifests != keepManifests {
			t.Errorf("KeepManifests = %d, want contract floor %d", g.KeepManifests, keepManifests)
		}
		raised := gcFlags{KeepManifests: keepManifests + 10}
		if err := raised.AfterApply(); err != nil {
			t.Fatal(err)
		}
		if g.KeepManifests != keepManifests+10 {
			t.Errorf("KeepManifests = %d, a RAISED value must be honored", g.KeepManifests)
		}
	})

	t.Run("net_copies_and_floors", func(t *testing.T) {
		g := resetGlobals(t)
		f := netFlags{MaxFeedSize: 0, CmdTimeout: time.Minute, AllowPrivateFetch: true}
		if err := f.AfterApply(); err != nil {
			t.Fatal(err)
		}
		if g.MaxFeedSize != defaultMaxFeedSize {
			t.Errorf("MaxFeedSize = %d, want floored default", g.MaxFeedSize)
		}
		if g.CmdTimeout != time.Minute || !g.AllowPrivateFetch {
			t.Errorf("copy failed: %+v", *g)
		}
	})
}

// --- parser-model pins -------------------------------------------------------

func newTestParser(t *testing.T) *kong.Kong {
	t.Helper()
	// The parser writes AfterApply values into the package globals; isolate.
	resetGlobals(t)
	var cli CLI
	parser, err := kong.New(&cli, kongOptions(nil)...)
	if err != nil {
		t.Fatalf("kong.New: %v", err)
	}
	return parser
}

func nodeFlags(n *kong.Node) map[string]bool {
	names := map[string]bool{}
	for _, f := range n.Flags {
		names[f.Name] = true
	}
	return names
}

func findCmd(t *testing.T, n *kong.Node, path ...string) *kong.Node {
	t.Helper()
	for _, name := range path {
		var next *kong.Node
		for _, c := range n.Children {
			if c.Name == name {
				next = c
				break
			}
		}
		if next == nil {
			t.Fatalf("command %q not found under %q", name, n.Name)
		}
		n = next
	}
	return n
}

// The help-noise regression pin: no cycle/gc/net flag may sit at the root
// (flattened into every command), each must appear where embedded, and a
// plain command must carry none of them. scopedFlagNamesList doubles as the
// yaml-resolution allowlist, so this test is also the struct<->list drift net.
func TestScopedFlagsAreNotGlobal(t *testing.T) {
	parser := newTestParser(t)
	root := nodeFlags(parser.Model.Node)
	for _, name := range scopedFlagNamesList {
		if root[name] {
			t.Errorf("--%s is a root (global) flag; it must live on its embedding commands only", name)
		}
	}
	fetch := nodeFlags(findCmd(t, parser.Model.Node, "fetch"))
	for _, name := range scopedFlagNamesList {
		if !fetch[name] {
			t.Errorf("srr fetch is missing --%s", name)
		}
	}
	feedRm := nodeFlags(findCmd(t, parser.Model.Node, "feed", "rm"))
	for _, name := range scopedFlagNamesList {
		if feedRm[name] {
			t.Errorf("srr feed rm --help still carries --%s", name)
		}
	}
	compact := nodeFlags(findCmd(t, parser.Model.Node, "store", "compact"))
	if !compact["keep-manifests"] {
		t.Error("srr store compact is missing --keep-manifests")
	}
	if compact["asset-process"] {
		t.Error("srr store compact must not carry cycleFlags")
	}
	preview := nodeFlags(findCmd(t, parser.Model.Node, "preview"))
	if !preview["max-feed-size"] || preview["pack-size"] {
		t.Error("srr preview must carry netFlags and not cycleFlags")
	}
}

// The approved tree: fetch top-level, art lists directly, the store group
// holds export/import/dedup/compact, and the old top-level forms are GONE.
func TestCommandTree(t *testing.T) {
	parser := newTestParser(t)
	rootCmds := map[string]bool{}
	for _, c := range parser.Model.Children {
		rootCmds[c.Name] = true
	}
	for _, want := range []string{"fetch", "art", "feed", "store", "asset",
		"syndicate", "recipe", "watch", "preview", "serve", "mcp", "frontend",
		"config", "inspect", "version"} {
		if !rootCmds[want] {
			t.Errorf("top-level command %q missing", want)
		}
	}
	for _, gone := range []string{"export", "import", "dedup", "compact"} {
		if rootCmds[gone] {
			t.Errorf("top-level command %q must have moved under store", gone)
		}
	}
	store := findCmd(t, parser.Model.Node, "store")
	for _, want := range []string{"export", "import", "dedup", "compact"} {
		findCmd(t, store, want)
	}
	// art is a leaf now (the old ls/fetch children are gone).
	art := findCmd(t, parser.Model.Node, "art")
	if len(art.Children) != 0 {
		t.Errorf("art must be a leaf command, has children: %v", art.Children)
	}
	// The reclaimed shorts.
	artFlags := map[string]rune{}
	for _, f := range art.Flags {
		artFlags[f.Name] = f.Short
	}
	if artFlags["since"] != 's' || artFlags["until"] != 'u' {
		t.Errorf("art --since/--until shorts = %q/%q, want s/u", artFlags["since"], artFlags["until"])
	}
}
