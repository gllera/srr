package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"srrb/store"
)

// Format atoms of the writer↔reader data contract. These are the single
// source of truth: `srr gen-ts` (cmd_gents.go) emits them to
// frontend/src/js/format.gen.ts for the frontend reader.
const (
	dbFileKey = "db.gz"
	dbLockKey = ".locked"
	// idxPackSize is the idx split threshold: entries per finalized pack.
	idxPackSize = 50000
	// metaPackSize is the meta/ split threshold: entries per finalized meta
	// shard. A divisor of idxPackSize (50000/5000 = 10) so a meta shard never
	// straddles an idx-pack boundary, keeping the meta↔idx mapping clean for
	// the writer and `srr inspect`.
	metaPackSize = 5000
	// feedIDCeiling is the feed-id ceiling: feed_id is a uint16 in each idx
	// entry, so ids run [0, feedIDCeiling).
	feedIDCeiling = 65536
	// idxStateSize is the 2 leading uint32 LE idx-header state fields
	// (packId/packOff bases).
	idxStateSize = 2 * 4
	// idxHeaderPrefix is the fixed idx-header prefix: the 2 state uint32s plus
	// the numSlots uint32. The variable cumulative-count array (numSlots × u32)
	// follows it.
	idxHeaderPrefix = idxStateSize + 4
	// idxEntrySize is the per-entry idx byte width: feed_id:u16 LE.
	idxEntrySize = 2
	// idxBoundarySize is the idx footer element width: each data-pack boundary
	// is a u16 LE local entry index at which the data packId advances by 1.
	idxBoundarySize = 2
	// searchGram is the rune length of the sliding windows ("trigrams") the
	// search blooms index, taken over each word of a folded title.
	searchGram = 3
	// searchBloomBytes is the fixed-size trigram Bloom filter prefixed inside
	// every finalized meta shard and concatenated into meta/s<N>.gz. 4096 bytes
	// = 2^15 bits — a power of two so probe indices mask instead of modulo,
	// sized for a 5,000-title shard.
	searchBloomBytes = 4096
	// searchBloomK is the number of bloom bits set/tested per gram. 7 is the
	// near-optimal probe count for ~3,500 trigrams in 2^15 bits ((m/n)·ln2 ≈
	// 6.5); it minimizes the per-(shard,gram) false-positive rate (~1.1%).
	searchBloomK = 7
)

// defaultRootPipe returns a fresh copy of the pipeline seeded into the
// reserved `default` recipe when a loaded db.gz has none. Returning a fresh
// slice each call keeps callers from mutating shared state.
func defaultRootPipe() []string {
	return []string{"#sanitize", "#minify"}
}

// defaultRecipeName is the reserved recipe every feed falls back to and the
// new home for what the old root pipe/ingest expressed. It always exists
// (NewDB seeds it); its pipe must not contain the #default composition token
// (enforced by the CLI: `recipe set default` rejects `#default`).
const defaultRecipeName = "default"

// Recipe is a named {ingest, pipe} bundle referenced by feeds (Feed.Recipe).
// An empty field means "inherit the default recipe's value for that axis":
// each axis falls back independently (see recipeFor + Feed.Fetch).
type Recipe struct {
	Ingest string   `json:"ingest,omitempty"`
	Pipe   []string `json:"pipe,omitempty"`
}

// recipeFor resolves a recipe name against the map. An empty or unknown name
// returns the default recipe — lenient, so a dangling reference (hand-edited
// db.gz) never crashes a fetch; the CLI prevents creating dangling refs. A
// plain map (not *DB) so the fetch path can resolve from fetchRun without
// threading the whole DB through Feed.Fetch.
func recipeFor(recipes map[string]Recipe, name string) Recipe {
	if name != "" {
		if r, ok := recipes[name]; ok {
			return r
		}
	}
	return recipes[defaultRecipeName]
}

func jsonEncode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// gunzip decompresses a gzip stream into a single byte slice.
func gunzip(r io.Reader) ([]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	return io.ReadAll(gz)
}

type DB struct {
	store.Backend
	core   DBCore
	locked bool
}

type DBCore struct {
	// Seq is the latest-pack generation: the current latest packs are
	// idx/L<Seq>.gz and data/L<Seq>.gz. 0 = empty store (no latest packs
	// yet); the first article batch publishes generation 1. PutArticles
	// bumps it in memory only after both L<Seq+1> saves succeed, and Commit
	// publishes it — so a generation name is never visible to readers
	// before its content is complete, and never rewritten afterwards.
	Seq           int   `json:"seq,omitempty"`
	FetchedAt     int64 `json:"fetched_at"`
	TotalArticles int   `json:"total_art"`
	NextPackID    int   `json:"next_pid"`
	PackOffset    int   `json:"pack_off"`
	// Gen is the store generation: bumped (srr gen --bump) after an in-place
	// store rebuild reuses finalized pack ids with new bytes, so the frontend
	// service worker can self-invalidate its cache-first pack cache. omitempty
	// is safe: the reader treats an absent key as 0. Known hazard: an old
	// binary (without this field) silently drops it on its next Commit (plain
	// json.Unmarshal) — accepted for a single-operator deployment.
	Gen int `json:"gen,omitempty"`
	// HdrPacks is the idx header-summary coverage: idx/h<HdrPacks>.gz holds
	// the verbatim variable-length headers of finalized idx packs 0..HdrPacks-1
	// (each idxHeaderPrefix + numSlots*4 bytes).
	// SyncIdxSummary sets it only after the summary save succeeds and Commit
	// publishes it (write-once name, same crash argument as Seq). Same
	// old-binary hazard as Gen: a binary without this field drops it on its
	// next Commit — readers then fall back to eager idx loading until the
	// next fetch with a new binary rebuilds the summary.
	HdrPacks int `json:"hdrs,omitempty"`
	// MetaPacks is the derived meta-shard coverage: meta/<n>.gz exists for n in
	// [0, MetaPacks) and meta/s<MetaPacks>.gz concatenates their bloom prefixes.
	// SyncMeta sets it only after every save succeeds and Commit publishes it
	// (write-once names, same crash argument as Seq / HdrPacks). The reader
	// offers search only when it equals numFinalizedMeta, and the list reads
	// meta packs only when MetaPacks+MetaTail fully cover the store (else it
	// falls back to the data/ source of truth).
	MetaPacks int `json:"mp,omitempty"`
	// MetaTail is the entry count of the published latest meta shard
	// (meta/L<Seq>.gz). SyncMeta trusts a read-back tail only when its count
	// matches, so a stale shard from a crash or a pre-`gen --bump` store is
	// rebuilt from data packs instead of extended.
	MetaTail int `json:"mt,omitempty"`
	// Recipes is the map of named {ingest, pipe} bundles feeds reference by
	// name (Feed.Recipe). Always contains the reserved "default" entry (seeded
	// by NewDB). Backend-only config: the frontend/service-worker ignores it,
	// like Out. omitempty is harmless — NewDB re-seeds an absent map.
	Recipes map[string]Recipe `json:"recipes,omitempty"`
	Feeds   map[int]*Feed     `json:"feeds"`
	// Out is the list of named syndication output feeds written by SyncOutFeeds
	// during each fetch cycle. Each OutFeed maps chosen tags/feed ids to one
	// RSS 2.0 or JSON Feed 1.1 file at out/<name>.<ext> on the CDN. Off by
	// default (nil → SyncOutFeeds no-op). Managed by `srr syndicate`.
	// NOTE: out/* objects are the ONE documented mutable class besides db.gz;
	// the frontend/service-worker ignores the `out` field entirely (backend-only
	// config and output key space).
	Out []OutFeed `json:"out,omitempty"`
}

// OutFeed declares one named syndication output: a rolling newest-N window of
// articles from the union of matching tags and explicit feed ids, serialised as
// RSS 2.0 or JSON Feed 1.1 and written to out/<Name>.<ext> each fetch cycle.
type OutFeed struct {
	// Name is the file stem: out/<Name>.rss or out/<Name>.json.
	Name string `json:"name"`
	// Title is the channel/feed title. Defaults to Name when empty.
	Title string `json:"title,omitempty"`
	// Format is "rss" (RSS 2.0) or "json" (JSON Feed 1.1).
	Format string `json:"format"`
	// Tags selects every feed whose Tag field is in this list.
	Tags []string `json:"tags,omitempty"`
	// Feeds selects individual feeds by id.
	Feeds []int `json:"feeds,omitempty"`
	// Limit is the maximum number of items to include (newest first).
	// Defaults to outDefaultLimit when 0.
	Limit int `json:"limit,omitempty"`
}

// withDB opens the DB, runs fn, and ensures Close. Use for commands that
// don't need to manage the parent context themselves.
func withDB(locked bool, fn func(ctx context.Context, db *DB) error) error {
	return withDBCtx(context.Background(), locked, fn)
}

// withDBCtx is the variant for callers that already have a context
// (e.g. signal-aware contexts in long-running commands).
func withDBCtx(ctx context.Context, locked bool, fn func(ctx context.Context, db *DB) error) error {
	db, err := NewDB(ctx, locked)
	if err != nil {
		return err
	}
	defer db.Close(ctx)
	return fn(ctx, db)
}

func NewDB(ctx context.Context, locked bool) (*DB, error) {
	backend, err := store.Open(ctx, globals.Store)
	if err != nil {
		return nil, err
	}

	db := &DB{
		Backend: backend,
		locked:  locked,
	}

	if locked {
		if err := db.Put(ctx, dbLockKey, bytes.NewReader(nil), globals.Force); err != nil {
			db.Backend.Close()
			return nil, fmt.Errorf("create lock file: %w", err)
		}
	}

	rc, err := db.Get(ctx, dbFileKey, true)
	if err != nil {
		db.Close(ctx)
		return nil, err
	}
	if rc != nil {
		data, err := gunzip(rc)
		rc.Close()
		if err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decompress %s: %w", dbFileKey, err)
		}
		if err := json.Unmarshal(data, &db.core); err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
		}
	}

	if db.core.Recipes == nil {
		db.core.Recipes = map[string]Recipe{}
	}
	if _, ok := db.core.Recipes[defaultRecipeName]; !ok {
		db.core.Recipes[defaultRecipeName] = Recipe{Pipe: defaultRootPipe()}
	}

	for id, ch := range db.core.Feeds {
		// feed_id is a uint16 in each idx entry, so ids run [0, feedIDCeiling).
		// An out-of-range id (hand-edited / migrated db.gz) would overflow the
		// entry encoding mid-fetch. Reject it here with a clear message instead.
		if id < 0 || id >= feedIDCeiling {
			db.Close(ctx)
			return nil, fmt.Errorf("feed id %d in %s out of range [0, %d]", id, dbFileKey, feedIDCeiling-1)
		}
		// An old feeds[]-only db.gz unmarshals to a feed with no top-level
		// url (the legacy feeds key is ignored). Reject it clearly rather than
		// silently fetch nothing.
		if ch.URL == "" {
			db.Close(ctx)
			return nil, fmt.Errorf("feed %d has no url; store predates the feed→feed merge — delete and re-fetch", id)
		}
		ch.id = id
	}
	return db, nil
}

func (o *DB) Close(ctx context.Context) error {
	if o.locked {
		if err := o.Rm(context.WithoutCancel(ctx), dbLockKey); err != nil {
			slog.Warn("remove lock file", "error", err)
		}
	}
	return o.Backend.Close()
}

// BumpGen increments the store generation and resets every derived-series
// coverage counter, keeping the bump-implies-reset invariant in one place:
// an in-place rebuild reuses finalized pack names with new bytes, so the
// published idx header summary and meta shards / bloom summary may hold
// stale content. Zeroed coverage makes the next fetch rebuild them (a zero
// MetaTail also marks the read-back tail untrusted); readers fall back to
// eager idx loading and keep search disabled in the gap.
func (o *DB) BumpGen() {
	o.core.Gen++
	o.core.HdrPacks = 0
	o.core.MetaPacks = 0
	o.core.MetaTail = 0
}

func (o *DB) Commit(ctx context.Context) error {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	enc := json.NewEncoder(gz)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(&o.core); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	return o.AtomicPut(ctx, dbFileKey, &buf, store.ObjectMeta{})
}

func (o *DB) Feeds() map[int]*Feed {
	return o.core.Feeds
}

func (o *DB) AddFeed(c *Feed) error {
	if o.core.Feeds == nil {
		o.core.Feeds = map[int]*Feed{}
	}
	for id := range feedIDCeiling {
		if _, ok := o.core.Feeds[id]; !ok {
			c.id = id
			c.AddIdx = o.core.TotalArticles
			o.core.Feeds[id] = c
			return nil
		}
	}
	return fmt.Errorf("maximum number of feeds reached (%d)", feedIDCeiling)
}

func (o *DB) RemoveFeed(id int) {
	delete(o.core.Feeds, id)
}

func (o *DB) FeedByID(id int) (*Feed, error) {
	if id < 0 || id >= feedIDCeiling {
		return nil, fmt.Errorf("feed id must be in [0, %d]", feedIDCeiling-1)
	}
	ch := o.core.Feeds[id]
	if ch == nil {
		return nil, fmt.Errorf("feed id %d not found", id)
	}
	return ch, nil
}

func (o *DB) readGz(ctx context.Context, key string) ([]byte, error) {
	rc, err := o.Get(ctx, key, false)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	defer rc.Close()
	out, err := gunzip(rc)
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	return out, nil
}
