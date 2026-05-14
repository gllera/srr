package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
)

// ArticleData is the on-disk JSONL representation of an article (one
// per line in data/*.gz). Short keys match what the frontend expects.
type ArticleData struct {
	ChannelID int    `json:"s"`
	FetchedAt int64  `json:"a"`
	Published int64  `json:"p,omitempty"`
	Title     string `json:"t,omitempty"`
	Link      string `json:"l,omitempty"`
	Content   string `json:"c"`
}

// Item is the in-memory representation of an article during fetch.
// PutArticles converts these into ArticleData before persistence.
type Item struct {
	Channel   *Channel
	Title     string
	Content   string
	Link      string
	Published int64
}

// dataKeyFor resolves a data pack key from a packID: finalized packs
// (id < NextPackID) use the numeric filename; otherwise the toggle name.
func dataKeyFor(core *DBCore, packID int) string {
	if packID < core.NextPackID {
		return fmt.Sprintf("data/%d.gz", packID)
	}
	return fmt.Sprintf("data/%v.gz", core.DataToggle)
}

// parseDataPack decodes a JSONL data pack (one ArticleData per line)
// from its decompressed bytes.
func parseDataPack(data []byte) ([]ArticleData, error) {
	var entries []ArticleData
	dec := json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var a ArticleData
		if err := dec.Decode(&a); err != nil {
			return nil, err
		}
		entries = append(entries, a)
	}
	return entries, nil
}

// pack buffers gzip-compressed bytes for a single idx or data pack
// being assembled in memory before flush.
type pack struct {
	buf bytes.Buffer
	gz  *gzip.Writer
	enc *json.Encoder
}

func newPack() *pack {
	p := &pack{}
	p.gz = gzip.NewWriter(&p.buf)
	p.enc = json.NewEncoder(p.gz)
	p.enc.SetEscapeHTML(false)
	return p
}

func (p *pack) Len() int                    { return p.buf.Len() }
func (p *pack) Write(b []byte) (int, error) { return p.gz.Write(b) }

func (p *pack) writeIdx(chanID, deltaPack, deltaFetched int) error {
	_, err := p.Write([]byte{byte(chanID), byte(deltaFetched) | byte(deltaPack)<<7})
	return err
}

func writeIdxHeader(p *pack, block, packID, packOff int, channels map[int]*Channel) error {
	var buf [idxHeaderSize]byte
	binary.LittleEndian.PutUint32(buf[0:], uint32(block))
	binary.LittleEndian.PutUint32(buf[4:], uint32(packID))
	binary.LittleEndian.PutUint32(buf[8:], uint32(packOff))
	for id, ch := range channels {
		binary.LittleEndian.PutUint32(buf[12+id*4:], uint32(ch.TotalArt))
	}
	_, err := p.Write(buf[:])
	return err
}

func (p *pack) writeArticle(ad *ArticleData) error {
	// json.Encoder writes a trailing newline (JSONL) directly into the gzip
	// writer, avoiding a per-article bytes.Buffer + Encoder allocation.
	return p.enc.Encode(ad)
}

func (o *DB) loadPack(ctx context.Context, key string) (*pack, int, error) {
	p := newPack()
	rc, err := o.Get(ctx, key, true)
	if err != nil {
		return nil, 0, err
	}
	if rc == nil {
		return p, 0, nil
	}
	defer rc.Close()
	raw, err := gunzip(rc)
	if err != nil {
		return nil, 0, err
	}
	if _, err := p.Write(raw); err != nil {
		return nil, 0, err
	}
	return p, len(raw), nil
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

func expectedLatestIdxSize(totalArticles int) int {
	if totalArticles == 0 {
		return 0
	}
	numFinalized := (totalArticles - 1) / idxPackSize
	latestEntries := totalArticles - numFinalized*idxPackSize
	return idxHeaderSize + latestEntries*2
}

func (o *DB) PutArticles(ctx context.Context, articles []*Item) error {
	if len(articles) == 0 {
		return nil
	}

	c := &o.core
	latest := fmt.Sprintf("%v.gz", c.DataToggle)

	meta, metaSize, err := o.loadPack(ctx, "idx/"+latest)
	if err != nil {
		return err
	}
	if expected := expectedLatestIdxSize(c.TotalArticles); metaSize != expected {
		return fmt.Errorf("idx/%s has %d bytes but db.gz expects %d", latest, metaSize, expected)
	}
	data, _, err := o.loadPack(ctx, "data/"+latest)
	if err != nil {
		return err
	}

	if c.FirstFetchedAt == 0 {
		c.FirstFetchedAt = c.FetchedAt
	}

	prevPackID := c.NextPackID
	prevFetchedTS := c.FirstFetchedAt/28800 + int64(c.FetchedAtCursor)
	var fetchedCarry int64

	for _, item := range articles {
		if c.TotalArticles > 0 && c.TotalArticles%idxPackSize == 0 {
			if err := o.savePack(ctx, fmt.Sprintf("idx/%d.gz", c.TotalArticles/idxPackSize-1), meta); err != nil {
				return err
			}
		}

		if meta.Len() == 0 {
			if err := writeIdxHeader(meta, c.FetchedAtCursor, c.NextPackID, c.PackOffset, c.Channels); err != nil {
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

		delta := c.FetchedAt/28800 - prevFetchedTS + fetchedCarry
		if delta > 0x7F {
			fetchedCarry = delta - 0x7F
			delta = 0x7F
		} else if delta < 0 {
			fetchedCarry = delta
			delta = 0
		} else {
			fetchedCarry = 0
		}
		if err := meta.writeIdx(item.Channel.id, c.NextPackID-prevPackID, int(delta)); err != nil {
			return err
		}

		c.FetchedAtCursor += int(delta)
		prevPackID = c.NextPackID
		prevFetchedTS = c.FetchedAt / 28800

		if err := data.writeArticle(&ArticleData{
			ChannelID: item.Channel.id,
			FetchedAt: c.FetchedAt,
			Published: item.Published,
			Title:     item.Title,
			Link:      item.Link,
			Content:   item.Content,
		}); err != nil {
			return err
		}

		c.TotalArticles++
		item.Channel.TotalArt++
		c.PackOffset++
	}

	// Flip the toggle only after both saves succeed — otherwise a mid-flight
	// data-pack failure leaves the in-memory toggle ahead of db.gz, and the
	// idx pack we just wrote becomes an orphan under the new-toggle filename.
	latest = fmt.Sprintf("%v.gz", !c.DataToggle)
	if err := o.savePack(ctx, "idx/"+latest, meta); err != nil {
		return err
	}
	if err := o.savePack(ctx, "data/"+latest, data); err != nil {
		return err
	}
	c.DataToggle = !c.DataToggle
	return nil
}
