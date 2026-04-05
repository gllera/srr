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
	idxPackSize = 50000
)

type ArticleData struct {
	SubID     int    `json:"s"`
	FetchedAt int64  `json:"a"`
	Published int64  `json:"p,omitempty"`
	Title     string `json:"t,omitempty"`
	Link      string `json:"l,omitempty"`
	Content   string `json:"c"`
}

type DB struct {
	store.Backend
	core          DBCore
	locked        bool
	startTotalArt int
}

type DBCore struct {
	DataToggle     bool            `json:"data_tog"`
	FetchedAt      int64           `json:"fetched_at"`
	SubSeq         int             `json:"sub_seq"`
	TotalArticles  int             `json:"total_art"`
	NextPackID     int             `json:"next_pid"`
	PackOffset     int             `json:"pack_off"`
	FirstFetchedAt int64           `json:"first_fetched,omitempty"`
	Subscriptions  []*Subscription `json:"subscriptions"`
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
		r, err := gzip.NewReader(rc)
		if err != nil {
			rc.Close()
			db.Close(ctx)
			return nil, fmt.Errorf("decompress %s: %w", dbFileKey, err)
		}
		data, err := io.ReadAll(r)
		r.Close()
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

	db.startTotalArt = db.core.TotalArticles
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
	return o.AtomicPut(ctx, dbFileKey, &buf)
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

func (p *pack) writeArticle(ad *ArticleData) error {
	data, err := jsonEncode(ad)
	if err != nil {
		return err
	}
	p.gz.Write(data)
	p.gz.Flush()
	return nil
}

func (o *DB) readGz(ctx context.Context, key string) ([]byte, error) {
	rc, err := o.Get(ctx, key, false)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	defer rc.Close()
	r, err := gzip.NewReader(rc)
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
	rc, err := o.Get(ctx, key, true)
	if err != nil {
		return nil, err
	}
	if rc == nil {
		return p, nil
	}
	defer rc.Close()
	r, err := gzip.NewReader(rc)
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
	if err := o.Put(ctx, key, &p.buf, true); err != nil {
		return err
	}
	p.buf.Reset()
	p.gz.Reset(&p.buf)
	return nil
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

	prevPackID := c.NextPackID
	prevFetchedAt := c.FetchedAt
	isFirstInIdxPack := meta.Len() == 0

	for _, item := range articles {
		if c.TotalArticles > 0 && c.TotalArticles%idxPackSize == 0 {
			if err := o.savePack(ctx, fmt.Sprintf("idx/%d.gz", c.TotalArticles/idxPackSize-1), meta); err != nil {
				return err
			}
			isFirstInIdxPack = true
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

		if isFirstInIdxPack {
			meta.writeTSV(item.Sub.ID, c.NextPackID, c.PackOffset, c.FetchedAt)
			isFirstInIdxPack = false
		} else {
			meta.writeTSV(item.Sub.ID, c.NextPackID-prevPackID, c.FetchedAt-prevFetchedAt)
		}
		prevPackID = c.NextPackID
		prevFetchedAt = c.FetchedAt

		if err := data.writeArticle(&ArticleData{
			SubID:     item.Sub.ID,
			FetchedAt: c.FetchedAt,
			Published: item.Published,
			Title:     item.Title,
			Link:      item.Link,
			Content:   item.Content,
		}); err != nil {
			return err
		}

		item.Sub.TotalArticles++
		item.Sub.LastAddedAt = c.FetchedAt

		c.TotalArticles++
		c.PackOffset++
	}

	if c.FirstFetchedAt == 0 && c.TotalArticles > 0 {
		c.FirstFetchedAt = c.FetchedAt
	}

	c.DataToggle = !c.DataToggle
	latest = fmt.Sprintf("%v.gz", o.core.DataToggle)
	if err := o.savePack(ctx, "idx/"+latest, meta); err != nil {
		return err
	}
	return o.savePack(ctx, "data/"+latest, data)
}
