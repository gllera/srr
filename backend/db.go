package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"slices"

	"srrb/store"
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

const (
	dbFileKey   = "db.gz"
	dbLockKey   = ".locked"
	idxPackSize = 1000
)

type DB struct {
	store.Backend
	core          DBCore
	locked        bool
	idxBoundaries []idxBoundary
}

type idxBoundary struct {
	totalArticles int
	subs          []idxBoundarySub
}

type idxBoundarySub struct {
	id            int
	totalArticles int
}

type DBCore struct {
	DataToggle     bool            `json:"data_tog"`
	TSToggle       bool            `json:"ts_tog"`
	FetchedAt      int64           `json:"fetched_at"`
	SubSeq         int             `json:"sub_seq"`
	TotalArticles  int             `json:"total_art"`
	NextPackID     int             `json:"next_pid"`
	PackOffset     int             `json:"pack_off"`
	FirstFetchedAt int64           `json:"first_fetched,omitempty"`
	Subscriptions  []*Subscription `json:"subscriptions"`
	oTotalArticles int
	oFetchedAt     int64
}

func NewDB(ctx context.Context, locked bool) (*DB, error) {
	backend, err := store.Open(ctx, globals.Store)
	if err != nil {
		return nil, err
	}

	if globals.Cache != "" {
		backend, err = store.NewCache(backend, globals.Cache, globals.Store)
		if err != nil {
			backend.Close()
			return nil, fmt.Errorf("initialize cache: %w", err)
		}
	}

	db := &DB{
		Backend: backend,
		locked:  locked,
	}

	if locked {
		if err := db.Put(ctx, dbLockKey, nil, globals.Force); err != nil {
			db.Backend.Close()
			return nil, fmt.Errorf("create lock file: %w", err)
		}
	}

	data, err := db.Get(ctx, dbFileKey, true)
	if err != nil {
		db.Close(ctx)
		return nil, err
	}

	if len(data) != 0 {
		r, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decompress %s: %w", dbFileKey, err)
		}
		data, err = io.ReadAll(r)
		r.Close()
		if err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decompress %s: %w", dbFileKey, err)
		}
		if err := json.Unmarshal(data, &db.core); err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
		}
		for _, s := range db.core.Subscriptions {
			s.oTotalArticles = s.TotalArticles
			s.oLastAddedAt = s.LastAddedAt
		}
	}

	db.core.oFetchedAt = db.core.FetchedAt
	db.core.oTotalArticles = db.core.TotalArticles
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
	data, err := jsonEncode(&o.core)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(data); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	return o.AtomicPut(ctx, dbFileKey, buf.Bytes())
}

func (o *DB) Subscriptions() []*Subscription {
	return o.core.Subscriptions
}

func (o *DB) AddSubscription(s *Subscription) {
	o.core.SubSeq++
	s.ID = o.core.SubSeq
	o.core.Subscriptions = append(o.core.Subscriptions, s)
}

func (o *DB) RemoveSubscription(id int) {
	for i, s := range o.core.Subscriptions {
		if s.ID == id {
			o.core.Subscriptions = slices.Delete(o.core.Subscriptions, i, i+1)
			return
		}
	}
}

type Item struct {
	Sub       *Subscription
	Title     string
	Content   string
	Link      string
	Published int64
}

type pack struct {
	buf bytes.Buffer
	gz  *gzip.Writer
}

func newPack() *pack {
	p := &pack{}
	p.gz = gzip.NewWriter(&p.buf)
	return p
}

func (p *pack) Len() int { return p.buf.Len() }

func (p *pack) writeTSV(fields ...any) {
	for i, f := range fields {
		if i > 0 {
			p.gz.Write([]byte{'\t'})
		}
		fmt.Fprint(p.gz, f)
	}
	p.gz.Write([]byte{'\n'})
	p.gz.Flush()
}

func (p *pack) writeEntry(s string) {
	io.WriteString(p.gz, s)
	p.gz.Write([]byte{0})
	p.gz.Flush()
}

func (o *DB) readGz(ctx context.Context, key string) ([]byte, error) {
	data, err := o.Get(ctx, key, false)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	return out, nil
}

func (o *DB) loadPack(ctx context.Context, key string) (*pack, error) {
	p := newPack()
	data, err := o.Get(ctx, key, true)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return p, nil
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(r)
	r.Close()
	if err != nil {
		return nil, err
	}
	if _, err := p.gz.Write(raw); err != nil {
		return nil, err
	}
	if err := p.gz.Flush(); err != nil {
		return nil, err
	}
	return p, nil
}

func (o *DB) savePack(ctx context.Context, key string, p *pack) error {
	if err := p.gz.Close(); err != nil {
		return err
	}
	if err := o.Put(ctx, key, p.buf.Bytes(), true); err != nil {
		return err
	}
	p.buf.Reset()
	p.gz.Reset(&p.buf)
	return nil
}

func (o *DB) UpdateTS(ctx context.Context) error {
	c := &o.core
	week := c.FetchedAt / 604800
	prevWeek := c.oFetchedAt / 604800
	full := prevWeek != week

	if !full && len(o.idxBoundaries) == 0 {
		return nil
	}

	ts, err := o.loadPack(ctx, fmt.Sprintf("ts/%v.gz", c.TSToggle))
	if err != nil {
		return err
	}

	if full {
		absSnap := []any{0, c.oTotalArticles}
		for _, s := range c.Subscriptions {
			if s.oTotalArticles > 0 {
				absSnap = append(absSnap, s.ID, s.oTotalArticles, s.oLastAddedAt)
			}
		}

		if c.oFetchedAt != 0 {
			if err := o.savePack(ctx, fmt.Sprintf("ts/%d.gz", prevWeek), ts); err != nil {
				return err
			}
			for w := prevWeek + 1; w < week; w++ {
				p := newPack()
				p.writeTSV(absSnap...)
				if err := o.savePack(ctx, fmt.Sprintf("ts/%d.gz", w), p); err != nil {
					return err
				}
			}
		}

		ts.writeTSV(absSnap...)
	}

	if c.FirstFetchedAt == 0 && c.TotalArticles > 0 {
		c.FirstFetchedAt = c.FetchedAt
	}

	for _, b := range o.idxBoundaries {
		delta := []any{c.FetchedAt % 604800, b.totalArticles}
		for _, s := range b.subs {
			delta = append(delta, s.id, s.totalArticles)
		}
		ts.writeTSV(delta...)
	}
	o.idxBoundaries = nil

	c.TSToggle = !c.TSToggle
	return o.savePack(ctx, fmt.Sprintf("ts/%v.gz", c.TSToggle), ts)
}

func (o *DB) PutArticles(ctx context.Context, articles []*Item) error {
	if len(articles) == 0 {
		return nil
	}

	c := &o.core
	latest := fmt.Sprintf("%v.gz", c.DataToggle)

	meta, err := o.loadPack(ctx, "idx/"+latest)
	if err != nil {
		return err
	}
	data, err := o.loadPack(ctx, "data/"+latest)
	if err != nil {
		return err
	}

	for _, item := range articles {
		if c.TotalArticles > 0 && c.TotalArticles%idxPackSize == 0 {
			var bSubs []idxBoundarySub
			for _, s := range c.Subscriptions {
				if s.TotalArticles > s.oTotalArticles {
					bSubs = append(bSubs, idxBoundarySub{s.ID, s.TotalArticles})
				}
			}
			o.idxBoundaries = append(o.idxBoundaries, idxBoundary{c.TotalArticles, bSubs})

			if err := o.savePack(ctx, fmt.Sprintf("idx/%d.gz", c.TotalArticles/idxPackSize-1), meta); err != nil {
				return err
			}
		}

		if data.Len() > 0 && data.Len() >= globals.PackSize<<10 {
			if err := o.savePack(ctx, fmt.Sprintf("data/%d.gz", c.NextPackID), data); err != nil {
				return err
			}
		}

		if data.Len() == 0 {
			c.NextPackID++
			c.PackOffset = 0
		}

		meta.writeTSV(c.FetchedAt, c.NextPackID, c.PackOffset, item.Sub.ID, item.Published, item.Title, item.Link)
		data.writeEntry(item.Content)

		item.Sub.TotalArticles++
		item.Sub.LastAddedAt = c.FetchedAt

		c.TotalArticles++
		c.PackOffset++
	}

	var bSubs []idxBoundarySub
	for _, s := range c.Subscriptions {
		if s.TotalArticles > s.oTotalArticles {
			bSubs = append(bSubs, idxBoundarySub{s.ID, s.TotalArticles})
		}
	}
	o.idxBoundaries = append(o.idxBoundaries, idxBoundary{c.TotalArticles, bSubs})

	c.DataToggle = !c.DataToggle
	latest = fmt.Sprintf("%v.gz", o.core.DataToggle)
	if err := o.savePack(ctx, "idx/"+latest, meta); err != nil {
		return err
	}
	return o.savePack(ctx, "data/"+latest, data)
}
