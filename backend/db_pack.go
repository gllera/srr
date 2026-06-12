package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
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

// genKey resolves the latest-pack key of a series ("idx" or "data") for a
// specific generation.
func genKey(prefix string, gen int) string {
	return fmt.Sprintf("%s/L%d.gz", prefix, gen)
}

// latestKey resolves the current latest-pack key of a series ("idx" or
// "data") from the store generation in core.Seq.
func latestKey(core *DBCore, prefix string) string {
	return genKey(prefix, core.Seq)
}

// summaryKey resolves the idx header-summary key covering n finalized idx
// packs.
func summaryKey(n int) string {
	return fmt.Sprintf("idx/h%d.gz", n)
}

// finalizedIdxKey resolves the key of finalized idx pack n.
func finalizedIdxKey(n int) string {
	return fmt.Sprintf("idx/%d.gz", n)
}

// dataKeyFor resolves a data pack key from a packID: finalized packs
// (id < NextPackID) use the numeric filename; otherwise the current
// latest-generation name.
func dataKeyFor(core *DBCore, packID int) string {
	if packID < core.NextPackID {
		return fmt.Sprintf("data/%d.gz", packID)
	}
	return latestKey(core, "data")
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
}

func newPack() *pack {
	p := &pack{}
	p.gz = gzip.NewWriter(&p.buf)
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
		binary.LittleEndian.PutUint32(buf[idxStateSize+id*4:], uint32(ch.TotalArt))
	}
	_, err := p.Write(buf[:])
	return err
}

func (p *pack) writeArticle(ad *ArticleData) error {
	data, err := jsonEncode(ad)
	if err != nil {
		return err
	}
	_, err = p.Write(data)
	return err
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

// latestKeep is the GC grace window: how many superseded latest-pack
// generations stay in the store alongside the current one. A reader whose
// db.gz is up to latestKeep fetch cycles old still resolves its own L<seq>
// snapshot; anything older gets a clean 404 (the frontend self-heals with a
// guarded reload). Mirrored by the frontend service worker's LATEST_KEEP.
const latestKeep = 2

// gcSweepWindow is how far below the GC cutoff each sweep reaches. Deleting
// only the newest expired name would let names leaked by a crash between
// Commit and GC live forever (the store interface has no List — only
// computed names can be deleted); a small trailing window self-heals them on
// later runs. Rm is silent on missing keys, so the extra calls are free.
const gcSweepWindow = 4

// gcSweep deletes the computed names of every generation in the trailing
// window below cutoff (the newest expired generation), never touching g < 1.
// Best-effort: callers treat errors as non-fatal.
func (o *DB) gcSweep(ctx context.Context, cutoff int, what string, keys func(g int) []string) error {
	for g := cutoff; g > cutoff-gcSweepWindow && g >= 1; g-- {
		for _, key := range keys(g) {
			if err := o.Rm(ctx, key); err != nil {
				return fmt.Errorf("gc %s %d: %w", what, g, err)
			}
		}
	}
	return nil
}

// GCLatest deletes superseded latest-pack generations, keeping the current
// one plus `keep` older generations as a grace window for readers holding a
// stale db.gz.
func (o *DB) GCLatest(ctx context.Context, keep int) error {
	return o.gcSweep(ctx, o.core.Seq-keep-1, "latest generation", func(g int) []string {
		return []string{genKey("idx", g), genKey("data", g)}
	})
}

// GCSummaries deletes superseded idx header summaries (idx/h<g>.gz) with the
// same grace window. Unlike Seq, HdrPacks advances by the number of packs
// finalized in a batch, so a >1 jump can strand an old summary outside every
// future window — a harmless ~1KB-per-50k-articles leak; the reader treats a
// missing summary by falling back to eager idx loading, so nothing
// user-visible depends on this sweep.
func (o *DB) GCSummaries(ctx context.Context, keep int) error {
	return o.gcSweep(ctx, o.core.HdrPacks-keep-1, "idx summary", func(g int) []string {
		return []string{summaryKey(g)}
	})
}

// numFinalizedIdx is the number of finalized idx packs for a given article
// count. Mirrors the frontend's numFinalizedIdx (data.ts).
func numFinalizedIdx(totalArticles int) int {
	if totalArticles == 0 {
		return 0
	}
	return (totalArticles - 1) / idxPackSize
}

func expectedLatestIdxSize(totalArticles int) int {
	if totalArticles == 0 {
		return 0
	}
	latestEntries := totalArticles - numFinalizedIdx(totalArticles)*idxPackSize
	return idxHeaderSize + latestEntries*2
}

// readIdxHeader decompresses only the leading idxHeaderSize bytes of an idx
// pack (gzip decodes from the stream head, so the entries are never
// inflated).
func (o *DB) readIdxHeader(ctx context.Context, key string) ([]byte, error) {
	rc, err := o.Get(ctx, key, false)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	gz, err := gzip.NewReader(rc)
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	defer gz.Close()
	hdr := make([]byte, idxHeaderSize)
	if _, err := io.ReadFull(gz, hdr); err != nil {
		return nil, fmt.Errorf("read %s header: %w", key, err)
	}
	return hdr, nil
}

// SyncIdxSummary publishes idx/h<N>.gz — the gzip concatenation of the
// 1036-byte headers of the N finalized idx packs — whenever db.gz's HdrPacks
// lags the store: a pack finalized this run, a pre-summary store's first run
// after upgrade, or a post-`srr gen --bump` reset. It always rebuilds from
// scratch by re-reading each finalized pack's header, keeping one code path
// that self-heals any prior state (the rebuild costs N small reads and runs
// once per 50k articles). HdrPacks is set only after the save succeeds and
// the caller's Commit publishes it — so, like L<Seq+1>, no reader can learn
// the h<N> name before its content is durable, and a crash-retry overwrite
// is invisible.
func (o *DB) SyncIdxSummary(ctx context.Context) error {
	c := &o.core
	n := numFinalizedIdx(c.TotalArticles)
	// HdrPacks > 0 with n == 0 is unreachable (HdrPacks only ever records a
	// past numFinalizedIdx, and TotalArticles never decreases), so n == 0
	// simply means there is nothing to publish yet.
	if c.HdrPacks == n || n == 0 {
		return nil
	}
	sum := newPack()
	for k := range n {
		hdr, err := o.readIdxHeader(ctx, finalizedIdxKey(k))
		if err != nil {
			return err
		}
		if _, err := sum.Write(hdr); err != nil {
			return err
		}
	}
	if err := o.savePack(ctx, summaryKey(n), sum); err != nil {
		return err
	}
	c.HdrPacks = n
	return nil
}

func (o *DB) PutArticles(ctx context.Context, articles []*Item) error {
	if len(articles) == 0 {
		return nil
	}

	c := &o.core

	meta, metaSize, err := o.loadPack(ctx, latestKey(c, "idx"))
	if err != nil {
		return err
	}
	if expected := expectedLatestIdxSize(c.TotalArticles); metaSize != expected {
		return fmt.Errorf("%s has %d bytes but db.gz expects %d", latestKey(c, "idx"), metaSize, expected)
	}
	data, _, err := o.loadPack(ctx, latestKey(c, "data"))
	if err != nil {
		return err
	}

	if c.FirstFetchedAt == 0 {
		c.FirstFetchedAt = c.FetchedAt
	}

	prevPackID := c.NextPackID
	prevFetchedTS := c.FirstFetchedAt/fetchedAtBlock + int64(c.FetchedAtCursor)
	// fetchedCarry is intentionally batch-local and its residual is dropped at
	// the end of PutArticles rather than persisted to DBCore. Within a batch it
	// drains over later entries (after the first entry prevFetchedTS == now, so
	// subsequent deltas consume it). A residual only survives when a batch has
	// fewer entries than ceil(gap/127) — i.e. very sparse fetches across a
	// >42-day dormancy gap. Dropping it keeps the reconstructed cursor
	// monotonically climbing toward true time and never overshooting; persisting
	// it would add the leftover onto the NEXT batch's fresh gap and overshoot
	// (the only cost of dropping is that the single oldest entry right after
	// such a gap reads slightly earlier than it was fetched, which self-corrects
	// on the following fetch).
	var fetchedCarry int64

	for _, item := range articles {
		if c.TotalArticles > 0 && c.TotalArticles%idxPackSize == 0 {
			if err := o.savePack(ctx, finalizedIdxKey(c.TotalArticles/idxPackSize-1), meta); err != nil {
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

		delta := c.FetchedAt/fetchedAtBlock - prevFetchedTS + fetchedCarry
		if delta > deltaFetchedMax {
			fetchedCarry = delta - deltaFetchedMax
			delta = deltaFetchedMax
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
		prevFetchedTS = c.FetchedAt / fetchedAtBlock

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

	// Write the next generation, and bump Seq only after both saves succeed
	// — otherwise a mid-flight data-pack failure leaves the in-memory Seq
	// ahead of db.gz, and the idx pack we just wrote becomes an orphan under
	// the new generation name. A crash here (before Commit publishes Seq)
	// leaves an orphan L<Seq+1> that the retry overwrites — safe even under
	// immutable cache headers because no client can learn a generation name
	// before Commit publishes it, so nothing has ever requested the orphan.
	// Any future feature that speculatively prefetches L<seq+1> would break
	// that invariant.
	if err := o.savePack(ctx, genKey("idx", c.Seq+1), meta); err != nil {
		return err
	}
	if err := o.savePack(ctx, genKey("data", c.Seq+1), data); err != nil {
		return err
	}
	c.Seq++
	return nil
}
