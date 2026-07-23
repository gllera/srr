package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"slices"

	"srr/store"
)

// The backend-only configuration sidecar — docs/MANIFEST-SPEC.md §4.3.
//
// config.gz is mutable, no-cache, and lives at the store root next to db.gz.
// The frontend and the service worker never fetch it, exactly like seen.gz, and
// it is deliberately NOT in store.PackSeries — it is never immutable. It is not
// referenced by any manifest either, so it participates in NO ordering argument
// with the manifest chain; §6.4's two-object ordering falls out of one property
// alone: an entry for a feed the store does not have is INERT and ignored.
//
// Under S32 nothing reads it back. db.gz remains the single source of truth for
// configuration, this object is written alongside, and `srr inspect --validate`
// cross-checks the two. That is what makes the dual-write trustworthy and the
// S34 swap a matter of changing which object is authoritative.
//
// ABSENCE IS LEGAL (§4.3): a store with no config.gz behaves exactly as one
// whose config is all defaults. Deleting it — like deleting every manifest —
// leaves the store fully functional.

const (
	configFileKey = "config.gz"
	// configLockKey is the config sidecar's own advisory marker (§6.3). It is
	// separate from dbLockKey on purpose: the stated goal of the split is that
	// config edits stop contending with a running fetch cycle, and a fetch
	// cycle READS config and never writes it, so writer↔editor exclusion is not
	// needed for correctness — only editor↔editor is (a GUI save racing a `srr
	// recipe set` on another box), which is a read-modify-write of one small
	// object.
	//
	// DEADLOCK DISCIPLINE: a mutation touching both manifest state and config
	// acquires .locked FIRST and .config.locked SECOND, never the reverse. In
	// S32 every config writer already holds .locked (config still lives in
	// db.gz), so the order is enforced by construction — syncConfig is only ever
	// called from Commit, which only ever runs under the store lock.
	configLockKey = ".config.locked"
)

// configSidecar is the config.gz document. It EMBEDS the same StoreConfig that
// DBCore embeds — so the store-wide half cannot drift from db.gz by omission —
// and carries the per-feed half as FeedConfig projections keyed by feed id.
type configSidecar struct {
	Version int `json:"v"`
	StoreConfig
	Feeds map[int]FeedConfig `json:"feeds,omitempty"`
}

// buildConfigSidecar projects the in-memory core into the sidecar document.
// Feeds carrying no configuration at all are omitted: an absent entry and an
// all-zero entry mean the same thing (§4.3), and omitting keeps the object
// small on a store that has never touched a recipe.
func (o *DB) buildConfigSidecar() configSidecar {
	feeds := map[int]FeedConfig{}
	for id, ch := range o.core.Feeds {
		if cfg := feedConfigOf(ch); !cfg.isZero() {
			feeds[id] = cfg
		}
	}
	return configSidecar{
		Version:     dbFormatVersion,
		StoreConfig: o.core.StoreConfig,
		Feeds:       feeds,
	}
}

// configSnapshot is a POINT-IN-TIME record of a published configuration: its
// canonical encoding plus the feed ids that carried an entry.
//
// Bytes, not the struct. A configSidecar shares its Recipes map and Out slice
// with the live DBCore it was projected from, so holding the struct would make
// the "snapshot" mutate along with the thing it is supposed to detect changes
// against — a `recipe set` would compare equal to itself and never publish.
type configSnapshot struct {
	sig     []byte
	feedIDs map[int]bool
}

// snapshotConfig captures the sidecar this handle would publish right now.
func (o *DB) snapshotConfig() *configSnapshot {
	c := o.buildConfigSidecar()
	sig, err := jsonEncode(canonicalConfig(c))
	if err != nil {
		// canonicalConfig holds only JSON-encodable values, so this is
		// unreachable; a nil sig degrades to "always republish", never to a
		// missed change.
		sig = nil
	}
	ids := make(map[int]bool, len(c.Feeds))
	for id := range c.Feeds {
		ids[id] = true
	}
	return &configSnapshot{sig: sig, feedIDs: ids}
}

// configChanged reports whether the sidecar this handle would now publish
// differs from the one it loaded at open — i.e. whether this session mutated
// configuration — and, separately, whether any feed LOST its config entry.
//
// The comparison is against the snapshot NewDB took of the loaded db.gz, which
// costs no extra store round-trip: db.gz is still the source of truth for
// configuration in S32, so "differs from what was loaded" is exactly "this
// session changed the config". A pre-S32 store (no manifest published yet) also
// counts as changed, which is what bootstraps config.gz on the first commit.
func (o *DB) configChanged(ctx context.Context) (changed, removals bool) {
	if o.configAtOpen == nil {
		return true, false
	}
	cur := o.snapshotConfig()
	for id := range o.configAtOpen.feedIDs {
		// removals selects §6.4's flip-FIRST-then-warn-only-config ordering,
		// which is crash-safe ONLY because a removed feed's leftover config
		// entry is inert (loadConfig skips it; configStale sweeps it). A feed
		// whose per-feed override was merely cleared back to defaults is ALSO
		// dropped from cur.feedIDs (buildConfigSidecar omits isZero entries),
		// but it is NOT inert — the feed is still live, so a stale config.gz
		// left by a crash between the root flip and the deferred write would
		// re-apply the old override to it on the next open, silently reverting
		// the edit. Gate on the feed actually being GONE from core.Feeds, so a
		// cleared-but-live edit takes the config-FIRST ordering instead.
		if _, live := o.core.Feeds[id]; !live {
			removals = true
			break
		}
	}
	if o.configAtOpen.sig == nil || cur.sig == nil || !bytes.Equal(o.configAtOpen.sig, cur.sig) {
		return true, removals
	}
	// Unchanged — but the sidecar has to exist for "unchanged" to mean
	// anything. A store whose config.gz was deleted (a rollback, an operator
	// clearing the S32 objects) would otherwise never publish one again, since
	// nothing about its configuration ever changes on a fetch cycle. One Stat
	// per DB handle closes that, and only until the first confirmation.
	if !o.configConfirmed {
		o.configConfirmed = true
		if size, err := o.Stat(ctx, configFileKey); err != nil || size == 0 {
			return true, removals
		}
	}
	// The signature matches what was loaded, but a stale entry the load flagged
	// still has to be swept (buildConfigSidecar drops it) — force the rewrite.
	return o.configStale, removals
}

// canonicalConfig renders a sidecar into a map-order-independent form. Go's
// encoder already sorts map keys, so this only has to sort the one slice whose
// order is incidental (Out is operator-ordered and IS significant, so it is
// left alone — only its content is compared).
func canonicalConfig(c configSidecar) any {
	feedIDs := slices.Sorted(maps.Keys(c.Feeds))
	feeds := make([]any, 0, len(feedIDs))
	for _, id := range feedIDs {
		feeds = append(feeds, []any{id, c.Feeds[id]})
	}
	return []any{c.Version, c.Recipes, c.DedupDays, c.Out, feeds}
}

// syncConfig writes config.gz under its own advisory marker. Callers hold
// dbLockKey already (see configLockKey's deadlock discipline).
func (o *DB) syncConfig(ctx context.Context) error {
	body, err := gzipJSON(o.buildConfigSidecar())
	if err != nil {
		return fmt.Errorf("encode %s: %w", configFileKey, err)
	}
	if err := o.Put(ctx, configLockKey, bytes.NewReader(nil), globals.Force); err != nil {
		return fmt.Errorf("create config lock file: %w", err)
	}
	defer func() {
		if err := o.Rm(context.WithoutCancel(ctx), configLockKey); err != nil {
			slog.Warn("remove config lock file", "error", err)
		}
	}()
	if err := o.AtomicPut(ctx, configFileKey, bytes.NewReader(body), store.ObjectMeta{}); err != nil {
		return fmt.Errorf("write %s: %w", configFileKey, err)
	}
	o.configAtOpen = o.snapshotConfig()
	o.configConfirmed = true
	o.configStale = false // the freshly-written sidecar lists only live feeds
	return nil
}

// loadConfigSidecar reads config.gz through an arbitrary fetcher (the checkers'
// path, local or HTTP).
func loadConfigSidecar(fetch keyGetter) (*configSidecar, error) {
	data, err := fetch(configFileKey)
	if err != nil {
		return nil, err
	}
	var c configSidecar
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("decode %s: %w", configFileKey, err)
	}
	return &c, nil
}

// loadConfig reads the sidecar into the open store's core. ABSENCE IS LEGAL
// (§4.3): a store with no config.gz behaves exactly as one whose configuration
// is all defaults, which is what makes the cutover's first commit — and any
// rollback — trivial. A PRESENT-but-corrupt object is a hard error: silently
// running a fetch cycle with the default recipe when the operator configured
// something else would rewrite every article through the wrong pipeline.
func (o *DB) loadConfig(ctx context.Context) error {
	rc, err := o.Get(ctx, configFileKey, true)
	if err != nil {
		return err
	}
	if rc == nil {
		return nil
	}
	data, err := gunzip(rc)
	rc.Close()
	if err != nil {
		return fmt.Errorf("decompress %s: %w", configFileKey, err)
	}
	var c configSidecar
	if err := json.Unmarshal(data, &c); err != nil {
		return fmt.Errorf("decode %s: %w", configFileKey, err)
	}
	if c.Version > dbFormatVersion {
		return fmt.Errorf("%s was written by a newer srr (format v%d, this binary supports v%d)", configFileKey, c.Version, dbFormatVersion)
	}
	o.core.StoreConfig = c.StoreConfig
	for id, cfg := range c.Feeds {
		if f := o.core.Feeds[id]; f != nil {
			applyFeedConfig(f, cfg)
			continue
		}
		// An entry for a feed the store does not have is INERT for now (§4.3) —
		// that is what makes the two-object mutations of §6.4 safe without a
		// distributed commit. But it is a latent hazard: reuse that id and the
		// next load would apply the removed feed's config to the NEW feed. Flag
		// it so the next config write sweeps it (buildConfigSidecar lists live
		// feeds only), closing the window before an id reuse can hit it.
		o.configStale = true
	}
	o.configConfirmed = true
	return nil
}
