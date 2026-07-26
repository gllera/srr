package main

import (
	"runtime"
	"testing"
	"time"
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
