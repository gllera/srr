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
	// chanIDCeiling is the channel-id ceiling: chan_id is a uint16 in each idx
	// entry, so ids run [0, chanIDCeiling).
	chanIDCeiling = 65536
	// idxStateSize is the 3 leading uint32 LE idx-header state fields
	// (fetchedAt/packId/packOff bases).
	idxStateSize = 3 * 4
	// idxHeaderPrefix is the fixed idx-header prefix: the 3 state uint32s plus
	// the numSlots uint32. The variable cumulative-count array (numSlots × u32)
	// follows it.
	idxHeaderPrefix = idxStateSize + 4
	// idxEntrySize is the per-entry idx byte width: chan_id:u16 LE + packed:u8.
	idxEntrySize = 3
	// fetchedAtBlock is the idx timestamp granularity in seconds (8h blocks):
	// fetched_at is stored as unix ÷ this (× this on read).
	fetchedAtBlock = 28800
	// deltaFetchedMax is the 7-bit per-entry delta_fetched_at limit: the
	// writer's clamp ceiling and the readers' bit mask.
	deltaFetchedMax = 0x7F
	// searchGram is the rune length of the sliding windows ("trigrams") the
	// search blooms index, taken over each word of a folded title.
	searchGram = 3
	// searchBloomBytes is the fixed-size trigram Bloom filter prefixed inside
	// every finalized search shard and concatenated into search/s<N>.gz. The
	// bit count is a power of two so probe indices mask instead of modulo.
	searchBloomBytes = 32768
	// searchBloomK is the number of bloom bits set/tested per gram.
	searchBloomK = 4
)

// defaultRootPipe returns a fresh copy of the pipeline applied as the
// db.gz root default when no explicit root pipe is stored. Channels
// still inherit/override normally; this just supplies the fallback for
// the topmost level. Returning a fresh slice each call keeps callers
// from accidentally mutating shared state.
func defaultRootPipe() []string {
	return []string{"#sanitize", "#minify"}
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
	// FirstFetchedAt is NOT omitempty: the reader divides by it
	// (frontend data.ts findChronForTimestamp) so the key must always be
	// present in db.gz — an absent key would decode to undefined → NaN.
	FirstFetchedAt  int64    `json:"first_fetched"`
	FetchedAtCursor int      `json:"fetched_at_cur,omitempty"`
	Pipe            []string `json:"pipe,omitempty"`
	Ingest          string   `json:"ingest,omitempty"`
	// Gen is the store generation: bumped (srr gen --bump) after an in-place
	// store rebuild reuses finalized pack ids with new bytes, so the frontend
	// service worker can self-invalidate its cache-first pack cache. omitempty
	// is safe: the reader treats an absent key as 0. Known hazard: an old
	// binary (without this field) silently drops it on its next Commit (plain
	// json.Unmarshal) — accepted for a single-operator deployment.
	Gen int `json:"gen,omitempty"`
	// HdrPacks is the idx header-summary coverage: idx/h<HdrPacks>.gz holds
	// the verbatim 1036-byte headers of finalized idx packs 0..HdrPacks-1.
	// SyncIdxSummary sets it only after the summary save succeeds and Commit
	// publishes it (write-once name, same crash argument as Seq). Same
	// old-binary hazard as Gen: a binary without this field drops it on its
	// next Commit — readers then fall back to eager idx loading until the
	// next fetch with a new binary rebuilds the summary.
	HdrPacks int `json:"hdrs,omitempty"`
	// SearchPacks is the finalized search-shard coverage: search/<n>.gz exists
	// for n in [0, SearchPacks) and search/s<SearchPacks>.gz concatenates their
	// bloom headers. SyncSearch sets it only after every save succeeds and
	// Commit publishes it (write-once names, same crash argument as Seq /
	// HdrPacks, same old-binary drop hazard). The reader offers search only
	// when it equals numFinalizedIdx.
	SearchPacks int `json:"srch,omitempty"`
	// SearchTail is the entry count of the published latest search shard
	// (search/L<Seq>.gz). SyncSearch trusts a read-back tail only when its
	// count matches, so a stale shard left by a crash or a pre-`gen --bump`
	// store is rebuilt from data packs instead of extended.
	SearchTail int              `json:"srcht,omitempty"`
	Channels   map[int]*Channel `json:"channels"`
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

	if db.core.Pipe == nil {
		db.core.Pipe = defaultRootPipe()
	}

	for id, ch := range db.core.Channels {
		// chan_id is a uint16 in each idx entry, so ids run [0, chanIDCeiling).
		// An out-of-range id (hand-edited / migrated db.gz) would overflow the
		// entry encoding mid-fetch. Reject it here with a clear message instead.
		if id < 0 || id >= chanIDCeiling {
			db.Close(ctx)
			return nil, fmt.Errorf("channel id %d in %s out of range [0, %d]", id, dbFileKey, chanIDCeiling-1)
		}
		// An old feeds[]-only db.gz unmarshals to a channel with no top-level
		// url (the legacy feeds key is ignored). Reject it clearly rather than
		// silently fetch nothing.
		if ch.URL == "" {
			db.Close(ctx)
			return nil, fmt.Errorf("channel %d has no url; store predates the feed→channel merge — delete and re-fetch", id)
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
// published idx header summary and search shards may hold stale content.
// Zeroed coverage makes the next fetch rebuild them (a zero SearchTail also
// marks the read-back tail untrusted); readers fall back to eager idx
// loading and keep search disabled in the gap.
func (o *DB) BumpGen() {
	o.core.Gen++
	o.core.HdrPacks = 0
	o.core.SearchPacks = 0
	o.core.SearchTail = 0
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
	return o.AtomicPut(ctx, dbFileKey, &buf)
}

func (o *DB) Channels() map[int]*Channel {
	return o.core.Channels
}

func (o *DB) AddChannel(c *Channel) error {
	if o.core.Channels == nil {
		o.core.Channels = map[int]*Channel{}
	}
	for id := range chanIDCeiling {
		if _, ok := o.core.Channels[id]; !ok {
			c.id = id
			c.AddIdx = o.core.TotalArticles
			o.core.Channels[id] = c
			return nil
		}
	}
	return fmt.Errorf("maximum number of channels reached (%d)", chanIDCeiling)
}

func (o *DB) RemoveChannel(id int) {
	delete(o.core.Channels, id)
}

func (o *DB) ChannelByID(id int) (*Channel, error) {
	if id < 0 || id >= chanIDCeiling {
		return nil, fmt.Errorf("channel id must be in [0, %d]", chanIDCeiling-1)
	}
	ch := o.core.Channels[id]
	if ch == nil {
		return nil, fmt.Errorf("channel id %d not found", id)
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
