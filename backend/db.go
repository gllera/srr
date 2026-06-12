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

const (
	dbFileKey     = "db.gz"
	dbLockKey     = ".locked"
	idxPackSize   = 50000
	idxHeaderSize = 259 * 4 // 3 state fields + 256 subCounts, all uint32 LE
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
	DataToggle    bool  `json:"data_tog"`
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
	Gen      int              `json:"gen,omitempty"`
	Channels map[int]*Channel `json:"channels"`
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
		// The idx format reserves exactly 256 chanCount slots and writeIdxHeader
		// indexes by id, so an out-of-range id (hand-edited / migrated db.gz)
		// would panic with "slice bounds out of range" mid-fetch. Reject it here
		// with a clear message instead.
		if id < 0 || id > 255 {
			db.Close(ctx)
			return nil, fmt.Errorf("channel id %d in %s out of range [0, 255]", id, dbFileKey)
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
	for id := 0; id <= 255; id++ {
		if _, ok := o.core.Channels[id]; !ok {
			c.id = id
			c.AddIdx = o.core.TotalArticles
			o.core.Channels[id] = c
			return nil
		}
	}
	return fmt.Errorf("maximum number of channels reached (256)")
}

func (o *DB) RemoveChannel(id int) {
	delete(o.core.Channels, id)
}

func (o *DB) ChannelByID(id int) (*Channel, error) {
	if id < 0 || id > 255 {
		return nil, fmt.Errorf("channel id must be in [0, 255]")
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
