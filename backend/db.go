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
	DataToggle      bool                  `json:"data_tog"`
	FetchedAt       int64                 `json:"fetched_at"`
	TotalArticles   int                   `json:"total_art"`
	NextPackID      int                   `json:"next_pid"`
	PackOffset      int                   `json:"pack_off"`
	FirstFetchedAt  int64                 `json:"first_fetched,omitempty"`
	FetchedAtCursor int                   `json:"fetched_at_cur,omitempty"`
	Subscriptions   map[int]*Subscription `json:"subscriptions"`
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

	for id, s := range db.core.Subscriptions {
		s.id = id
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

func (o *DB) Subscriptions() map[int]*Subscription {
	return o.core.Subscriptions
}

func (o *DB) AddSubscription(s *Subscription) error {
	if o.core.Subscriptions == nil {
		o.core.Subscriptions = map[int]*Subscription{}
	}
	for id := 0; id <= 255; id++ {
		if _, ok := o.core.Subscriptions[id]; !ok {
			s.id = id
			s.AddIdx = o.core.TotalArticles
			o.core.Subscriptions[id] = s
			return nil
		}
	}
	return fmt.Errorf("maximum number of subscriptions reached (256)")
}

func (o *DB) RemoveSubscription(id int) {
	delete(o.core.Subscriptions, id)
}

func (o *DB) SubByID(id int) (*Subscription, error) {
	if id < 0 || id > 255 {
		return nil, fmt.Errorf("subscription id must be in [0, 255]")
	}
	sub := o.core.Subscriptions[id]
	if sub == nil {
		return nil, fmt.Errorf("subscription id %d not found", id)
	}
	return sub, nil
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
