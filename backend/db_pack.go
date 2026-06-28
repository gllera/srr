package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"

	"github.com/foobaz/go-zopfli/zopfli"
)

// ArticleData is the on-disk JSONL representation of an article (one
// per line in data/*.gz). Short keys match what the frontend expects.
type ArticleData struct {
	FeedID    int    `json:"f"`
	FetchedAt int64  `json:"a"`
	Published int64  `json:"p,omitempty"`
	Title     string `json:"t,omitempty"`
	Link      string `json:"l,omitempty"`
	Content   string `json:"c"`
}

// Item is the in-memory representation of an article during fetch.
// PutArticles converts these into ArticleData before persistence.
type Item struct {
	Feed      *Feed
	Title     string
	Content   string
	Link      string
	Published int64
}

// articleData is the one Item→ArticleData mapping. PutArticles applies it
// and returns the results, so SyncMeta's derived meta entries are built
// from the very values the packs hold.
func (it *Item) articleData(fetchedAt int64) ArticleData {
	return ArticleData{
		FeedID:    it.Feed.id,
		FetchedAt: fetchedAt,
		Published: it.Published,
		Title:     it.Title,
		Link:      it.Link,
		Content:   it.Content,
	}
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

// idxKeyAndSize resolves the store key and entry count of idx pack p:
// finalized packs use the numeric name and are always full; the latest pack
// uses the L<seq> generation name and holds the tail.
func idxKeyAndSize(core *DBCore, p int) (string, int) {
	if p < numFinalizedIdx(core.TotalArticles) {
		return finalizedIdxKey(p), idxPackSize
	}
	return latestKey(core, "idx"), core.TotalArticles - p*idxPackSize
}

// finalizedDataKey resolves the key of finalized data pack n.
func finalizedDataKey(n int) string {
	return fmt.Sprintf("data/%d.gz", n)
}

// dataKeyFor resolves a data pack key from a packID: finalized packs
// (id < NextPackID) use the numeric filename; otherwise the current
// latest-generation name.
func dataKeyFor(core *DBCore, packID int) string {
	if packID < core.NextPackID {
		return finalizedDataKey(packID)
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

func (p *pack) writeIdx(feedID int) error {
	_, err := p.Write([]byte{byte(feedID), byte(feedID >> 8)})
	return err
}

// writeIdxFooter appends the data-pack boundary list — u16 LE local entry
// indices at which the data packId advances by 1 — to a finished idx pack.
// It carries what the old per-entry delta_pack_id bit did, out of the entries.
func writeIdxFooter(p *pack, boundaries []int) error {
	buf := make([]byte, len(boundaries)*idxBoundarySize)
	for i, b := range boundaries {
		binary.LittleEndian.PutUint16(buf[i*idxBoundarySize:], uint16(b))
	}
	_, err := p.Write(buf)
	return err
}

// parseIdxFooter reads a u16 LE boundary list (the bytes after header+entries
// of an already-saved latest idx pack) back into local-index form, so an
// append can re-emit the full footer.
func parseIdxFooter(footer []byte) []int {
	out := make([]int, len(footer)/idxBoundarySize)
	for i := range out {
		out[i] = int(binary.LittleEndian.Uint16(footer[i*idxBoundarySize:]))
	}
	return out
}

func writeIdxHeader(p *pack, packID, packOff int, feeds map[int]*Feed) error {
	numSlots := 0
	for id := range feeds {
		if id+1 > numSlots {
			numSlots = id + 1
		}
	}
	buf := make([]byte, idxHeaderPrefix+numSlots*4)
	binary.LittleEndian.PutUint32(buf[0:], uint32(packID))
	binary.LittleEndian.PutUint32(buf[4:], uint32(packOff))
	binary.LittleEndian.PutUint32(buf[idxStateSize:], uint32(numSlots))
	for id, ch := range feeds {
		binary.LittleEndian.PutUint32(buf[idxHeaderPrefix+id*4:], uint32(ch.TotalArt))
	}
	_, err := p.Write(buf)
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

// loadPack fetches and decompresses the pack at key into its raw bytes, or nil
// when the key is absent (Get with ignoreMissing). Callers that need to append
// wrap the bytes with packFromBytes.
func (o *DB) loadPack(ctx context.Context, key string) ([]byte, error) {
	rc, err := o.Get(ctx, key, true)
	if err != nil {
		return nil, err
	}
	if rc == nil {
		return nil, nil
	}
	defer rc.Close()
	return gunzip(rc)
}

// packFromBytes wraps decompressed pack bytes into an appendable *pack. The
// length guard is load-bearing: gzip.NewWriter flushes its header on the first
// Write — including Write(nil) — so an empty pack must skip the Write to keep
// Len()==0, the fresh-store sentinel the idx/data writers branch on.
func packFromBytes(raw []byte) (*pack, error) {
	p := newPack()
	if len(raw) > 0 {
		if _, err := p.Write(raw); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// savePack publishes a pack with the fast stdlib gzip encoding it was
// streamed through — right for the names rewritten on every cycle (latest
// generations, summaries).
func (o *DB) savePack(ctx context.Context, key string, p *pack) error {
	return o.flushPack(ctx, key, p, false)
}

// savePackFinal publishes a finalized pack. Finalized names are immutable
// and downloaded forever, so it spends zopfli-grade CPU recompressing them.
func (o *DB) savePackFinal(ctx context.Context, key string, p *pack) error {
	return o.flushPack(ctx, key, p, true)
}

// finalGzip is the finalized-pack recompressor, a var only as a test seam:
// the 50k-boundary tests would otherwise spend ~10s of zopfli CPU per shard
// (setupTestDB stubs it to identity). Production always runs gzipBest.
var finalGzip = gzipBest

func (o *DB) flushPack(ctx context.Context, key string, p *pack, final bool) error {
	if err := p.gz.Close(); err != nil {
		return err
	}
	out := p.buf.Bytes()
	if final {
		var err error
		if out, err = finalGzip(key, out); err != nil {
			return err
		}
	}
	if err := o.Put(ctx, key, bytes.NewReader(out), true); err != nil {
		return err
	}
	p.buf.Reset()
	p.gz.Reset(&p.buf)
	return nil
}

// gzipBest recompresses an already-gzipped pack with zopfli's exhaustive
// deflate search (measured 2026-06-12: data packs −4%, idx packs −11% vs the
// stdlib encoder). The output is still plain RFC 1952 gzip, so readers need
// no change and old and new packs coexist. The obscure dependency is not
// trusted with the write-once names: the candidate must round-trip
// byte-for-byte through the stdlib gzip reader, else the save fails — a
// finalized name is cached forever, so corrupt bytes must never publish.
// Returns the input when zopfli can't beat it (incompressible content).
func gzipBest(key string, gz []byte) ([]byte, error) {
	raw, err := gunzip(bytes.NewReader(gz))
	if err != nil {
		return nil, fmt.Errorf("recompress %s: read input: %w", key, err)
	}
	var best bytes.Buffer
	opts := zopfli.DefaultOptions()
	if err := zopfli.GzipCompress(&opts, raw, &best); err != nil {
		return nil, fmt.Errorf("recompress %s: %w", key, err)
	}
	back, err := gunzip(bytes.NewReader(best.Bytes()))
	if err != nil {
		return nil, fmt.Errorf("recompress %s: round-trip: %w", key, err)
	}
	if !bytes.Equal(back, raw) {
		return nil, fmt.Errorf("recompress %s: round-trip mismatch", key)
	}
	if best.Len() >= len(gz) {
		return gz, nil
	}
	return best.Bytes(), nil
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
		// Pre-meta generations never wrote a meta/L name; Rm is silent on
		// missing keys, so sweeping it unconditionally costs nothing.
		return []string{genKey("idx", g), genKey("data", g), genKey("meta", g)}
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

// latestIdxEntryCount is the entry count the latest idx pack must hold for a
// given article total (the tail past the finalized packs).
func latestIdxEntryCount(totalArticles int) int {
	if totalArticles == 0 {
		return 0
	}
	return totalArticles - numFinalizedIdx(totalArticles)*idxPackSize
}

// checkLatestIdx verifies a freshly-loaded latest idx pack matches db.gz: its
// entry count (derived from the variable header's numSlots) must equal the tail
// count. The pack ends with a variable-length u16 boundary footer, so the
// header+entries length is a lower bound and the trailing bytes must be a whole
// number of u16 boundaries. It returns entriesEnd — the offset where the entries
// end and the footer begins — so the append path can split the footer off without
// re-deriving the variable-header geometry (0 for an empty store). Guards against
// a stale latest pack / format mismatch.
func checkLatestIdx(key string, raw []byte, totalArticles int) (entriesEnd int, err error) {
	want := latestIdxEntryCount(totalArticles)
	if want == 0 {
		if len(raw) != 0 {
			return 0, fmt.Errorf("%s has %d bytes but db.gz expects an empty store", key, len(raw))
		}
		return 0, nil
	}
	if len(raw) < idxHeaderPrefix {
		return 0, fmt.Errorf("%s: short idx header (%d bytes)", key, len(raw))
	}
	numSlots := int(binary.LittleEndian.Uint32(raw[idxStateSize:]))
	entriesEnd = idxHeaderPrefix + numSlots*4 + want*idxEntrySize
	if len(raw) < entriesEnd {
		return 0, fmt.Errorf("%s has %d bytes but db.gz expects at least %d", key, len(raw), entriesEnd)
	}
	if (len(raw)-entriesEnd)%idxBoundarySize != 0 {
		return 0, fmt.Errorf("%s footer is not a whole number of u16 boundaries (%d trailing bytes)",
			key, len(raw)-entriesEnd)
	}
	return entriesEnd, nil
}

// readPackHeader decompresses only the leading size bytes of a pack (gzip
// decodes from the stream head, so the entries are never inflated). Used for
// the search shards' fixed-size bloom headers; idx packs use readIdxHeader,
// whose header is variable-length.
func (o *DB) readPackHeader(ctx context.Context, key string, size int) ([]byte, error) {
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
	hdr := make([]byte, size)
	if _, err := io.ReadFull(gz, hdr); err != nil {
		return nil, fmt.Errorf("read %s header: %w", key, err)
	}
	return hdr, nil
}

// readIdxHeader decompresses just the variable-length header of an idx pack:
// the fixed prefix, then numSlots×4 cumulative-count bytes.
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
	prefix := make([]byte, idxHeaderPrefix)
	if _, err := io.ReadFull(gz, prefix); err != nil {
		return nil, fmt.Errorf("read %s header prefix: %w", key, err)
	}
	numSlots := int(binary.LittleEndian.Uint32(prefix[idxStateSize:]))
	rest := make([]byte, numSlots*4)
	if _, err := io.ReadFull(gz, rest); err != nil {
		return nil, fmt.Errorf("read %s header counts: %w", key, err)
	}
	return append(prefix, rest...), nil
}

// saveSummary publishes a count-named summary pack: the gzip concatenation
// of the headers of finalized packs 0..n-1, each produced by the `header`
// callback. The crash-safety contract is the caller's: it advances its
// coverage counter only after this save succeeds, so no reader can learn the
// summary name before its content is durable. Shared by SyncIdxSummary
// (idx/h<N>, variable-length header) and SyncMeta (meta/s<N>, fixed bloom
// header).
func (o *DB) saveSummary(ctx context.Context, n int, header func(k int) ([]byte, error), sumKey string) error {
	sum := newPack()
	for k := range n {
		hdr, err := header(k)
		if err != nil {
			return err
		}
		if _, err := sum.Write(hdr); err != nil {
			return err
		}
	}
	return o.savePack(ctx, sumKey, sum)
}

// SyncIdxSummary publishes idx/h<N>.gz — the gzip concatenation of the
// variable-length headers of the N finalized idx packs — whenever db.gz's
// HdrPacks lags the store: a pack finalized this run, a pre-summary store's
// first run after upgrade, or a post-`srr gen --bump` reset. It always rebuilds from
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
	if err := o.saveSummary(ctx, n, func(k int) ([]byte, error) {
		return o.readIdxHeader(ctx, finalizedIdxKey(k))
	}, summaryKey(n)); err != nil {
		return err
	}
	c.HdrPacks = n
	return nil
}

// PutArticles persists the batch into the idx and data series and returns
// the ArticleData it wrote, in pack order — SyncMeta consumes that slice,
// so the derived meta entries can never drift from the packs.
func (o *DB) PutArticles(ctx context.Context, articles []*Item) ([]ArticleData, error) {
	if len(articles) == 0 {
		return nil, nil
	}

	c := &o.core

	metaRaw, err := o.loadPack(ctx, latestKey(c, "idx"))
	if err != nil {
		return nil, err
	}
	entriesEnd, err := checkLatestIdx(latestKey(c, "idx"), metaRaw, c.TotalArticles)
	if err != nil {
		return nil, err
	}
	dataRaw, err := o.loadPack(ctx, latestKey(c, "data"))
	if err != nil {
		return nil, err
	}
	data, err := packFromBytes(dataRaw)
	if err != nil {
		return nil, err
	}

	// The latest idx pack = header ‖ entries ‖ u16-boundary footer. Appending
	// means dropping the old footer, keeping header+entries, recovering the
	// boundary list, then re-emitting it at save. localIdx is the next entry's
	// position within the current latest idx pack; boundaries holds the local
	// indices at which the data packId has advanced (what the old per-entry
	// delta_pack_id bit encoded). entriesEnd (from checkLatestIdx, 0 on an empty
	// store) is where the entries end and the old footer begins.
	var boundaries []int
	localIdx := latestIdxEntryCount(c.TotalArticles)
	meta := newPack()
	if entriesEnd > 0 {
		boundaries = parseIdxFooter(metaRaw[entriesEnd:])
		if _, err := meta.Write(metaRaw[:entriesEnd]); err != nil {
			return nil, err
		}
	}

	prevPackID := c.NextPackID
	written := make([]ArticleData, 0, len(articles))

	for _, item := range articles {
		if c.TotalArticles > 0 && c.TotalArticles%idxPackSize == 0 {
			if err := writeIdxFooter(meta, boundaries); err != nil {
				return nil, err
			}
			if err := o.savePackFinal(ctx, finalizedIdxKey(c.TotalArticles/idxPackSize-1), meta); err != nil {
				return nil, err
			}
			// savePackFinal resets meta; the next entry starts a fresh idx pack.
			boundaries = nil
			localIdx = 0
		}

		if meta.Len() == 0 {
			if err := writeIdxHeader(meta, c.NextPackID, c.PackOffset, c.Feeds); err != nil {
				return nil, err
			}
		}

		if data.Len() > 0 && data.Len() >= globals.PackSize<<10 {
			if err := o.savePackFinal(ctx, finalizedDataKey(c.NextPackID), data); err != nil {
				return nil, err
			}
		}

		if data.Len() == 0 {
			c.NextPackID++
			c.PackOffset = 0
		}

		// A data-pack roll since the previous entry (NextPackID advanced) is a
		// boundary at this local index — recorded in the footer, not the entry.
		if c.NextPackID != prevPackID {
			boundaries = append(boundaries, localIdx)
		}
		if err := meta.writeIdx(item.Feed.id); err != nil {
			return nil, err
		}
		localIdx++
		prevPackID = c.NextPackID

		ad := item.articleData(c.FetchedAt)
		if err := data.writeArticle(&ad); err != nil {
			return nil, err
		}
		written = append(written, ad)

		c.TotalArticles++
		item.Feed.TotalArt++
		c.PackOffset++
	}

	// Seal the latest (non-finalized) idx pack with its boundary footer before
	// saving — same shape as a finalized pack, so the reader's parse is uniform.
	if err := writeIdxFooter(meta, boundaries); err != nil {
		return nil, err
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
		return nil, err
	}
	if err := o.savePack(ctx, genKey("data", c.Seq+1), data); err != nil {
		return nil, err
	}
	c.Seq++
	return written, nil
}
