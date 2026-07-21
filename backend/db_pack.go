package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"github.com/foobaz/go-zopfli/zopfli"

	"srr/store"
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
	// Lang is the article's ISO 639-1 language code, carried from the fetch
	// pipeline (RawItem.Lang). Packed under "g" (omitempty — the fail-open
	// detection leaves it empty on uncertain articles, which then carry no
	// field at all); articles written before 2026-07-19 predate it, so an
	// absent/empty value always means "unknown", never "not applicable".
	Lang string `json:"g,omitempty"`
}

// displayTime is the display-timestamp rule shared by meta cards
// (MetaEntry.When) and syndication outputs: Published, falling back to
// FetchedAt for dateless articles.
func (ad ArticleData) displayTime() int64 {
	if ad.Published != 0 {
		return ad.Published
	}
	return ad.FetchedAt
}

// Item is the in-memory representation of an article during fetch.
// PutArticles converts these into ArticleData before persistence.
type Item struct {
	Feed      *Feed
	Title     string
	Content   string
	Link      string
	Published int64
	Lang      string
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
		Lang:      it.Lang,
	}
}

// genKey resolves the latest-pack key of a series ("idx" or "data") for a
// specific generation.
func genKey(prefix string, gen int) string {
	return fmt.Sprintf("%s/L%d.gz", prefix, gen)
}

// tailGen is the generation of the consolidated tail packs
// (idx|data|meta/L<tailGen>): Seq minus the live delta count. With no deltas
// (NumDeltas 0 — every pre-delta store, and every store right after a
// consolidation) it equals Seq, the historical "latest packs live at L<Seq>"
// layout.
func tailGen(core *DBCore) int {
	return core.Seq - core.NumDeltas
}

// tailCovered is the chron seam between packs and deltas: chrons below it are
// served by the pack series, chrons at/above it by the live delta segments.
func tailCovered(core *DBCore) int {
	return core.TotalArticles - core.DeltaArticles
}

// deltaKey resolves the delta-segment key of generation g. Deltas live in the
// data/ series on purpose: they ARE article data (one cycle's batch as
// data-pack JSONL), they inherit the CDN edge-cache rule's /data/ prefix, and
// "d" slots into the PackSeries grammar as one more write-once kind letter.
func deltaKey(g int) string {
	return fmt.Sprintf("data/d%d.gz", g)
}

// dbSnapshotKey resolves the write-once db.gz snapshot key of tail generation
// g (see DB.SnapshotDB). Its own "db" series in the PackSeries grammar, with no
// kind letters — bare stems only, like a finalized pack.
func dbSnapshotKey(g int) string {
	return fmt.Sprintf("db/%d.gz", g)
}

// latestKey resolves the current tail-pack key of a series ("idx", "data",
// "meta"): the L<tailGen> generation (see tailGen).
func latestKey(core *DBCore, prefix string) string {
	return genKey(prefix, tailGen(core))
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

// idxKeyAndSize resolves the store key and PHYSICAL entry count of idx pack p:
// finalized packs use the numeric name and are always full; the latest pack
// uses the L<tailGen> generation name and holds the consolidated tail only —
// entries at chron >= tailCovered live in the delta segments, not in any idx
// pack (callers extend the parsed latest pack with them; see loadLatestIdx).
func idxKeyAndSize(core *DBCore, p int) (string, int) {
	if p < numFinalizedIdx(core.TotalArticles) {
		return finalizedIdxKey(p), idxPackSize
	}
	return latestKey(core, "idx"), tailCovered(core) - p*idxPackSize
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

// splitDataPack decodes a data-pack buffer into both its verbatim per-article
// JSONL line bytes (each including its trailing newline) and the parsed
// ArticleData, in parallel. jsonEncode writes one newline-terminated line per
// article with no embedded newlines (JSON escapes them), so a split on '\n' is
// exact. Used by loadDeltaChain so consolidation can re-emit the delta bytes
// verbatim (identical to a re-encode, minus the CPU).
func splitDataPack(data []byte) (lines [][]byte, entries []ArticleData, err error) {
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		var line []byte
		if i < 0 {
			line, data = data, nil // tolerate a missing final newline
		} else {
			line, data = data[:i+1], data[i+1:]
		}
		var a ArticleData
		if err := json.Unmarshal(bytes.TrimRight(line, "\n"), &a); err != nil {
			return nil, nil, err
		}
		lines = append(lines, line)
		entries = append(entries, a)
	}
	return lines, entries, nil
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

// writeIdxHeader emits the variable-length idx header: the 2 state u32s, the
// numSlots u32, then `counts` verbatim — the per-feed cumulative totals AS OF
// the pack's first chron. The caller owns that as-of discipline: the live
// per-cycle path passes the feeds' current TotalArt (accounting interleaves
// with materialization there), while consolidation replays stored deltas after
// accounting already ran and must thread its own rewound count vector (see
// consolidateTail — the deferred-replay subtlety the equivalence test pins).
func writeIdxHeader(p *pack, packID, packOff int, counts []uint32) error {
	numSlots := len(counts)
	buf := make([]byte, idxHeaderPrefix+numSlots*4)
	binary.LittleEndian.PutUint32(buf[0:], uint32(packID))
	binary.LittleEndian.PutUint32(buf[4:], uint32(packOff))
	binary.LittleEndian.PutUint32(buf[idxStateSize:], uint32(numSlots))
	for id, n := range counts {
		binary.LittleEndian.PutUint32(buf[idxHeaderPrefix+id*4:], n)
	}
	_, err := p.Write(buf)
	return err
}

// liveCounts builds the dense per-feed TotalArt vector (numSlots = high-water
// live feed id + 1, the same width writeIdxHeader always emitted). Slots with
// no live feed stay 0 — exactly what the old map-driven header wrote for them.
func liveCounts(feeds map[int]*Feed) []uint32 {
	numSlots := 0
	for id := range feeds {
		if id+1 > numSlots {
			numSlots = id + 1
		}
	}
	counts := make([]uint32, numSlots)
	for id, ch := range feeds {
		counts[id] = uint32(ch.TotalArt)
	}
	return counts
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
	// AtomicPut, not Put: local/SFTP then write to a temp file, fsync it, and
	// rename (plus the parent-dir fsync). A plain Put leaves pack bytes in page
	// cache while Commit's own AtomicPut makes db.gz durable — so a power loss
	// can publish a committed db.gz addressing truncated packs, under immutable
	// names cached forever. S3/HTTP are unchanged overwrites either way, and
	// the empty ObjectMeta keeps Content-Type falling through to
	// contentTypeForKey exactly as before. Put's ignoreExisting=true matched
	// AtomicPut's overwrite semantics already.
	if err := o.AtomicPut(ctx, key, bytes.NewReader(out), store.ObjectMeta{}); err != nil {
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
// `window` below cutoff (the newest expired generation), never touching g < 1.
// Best-effort: callers treat errors as non-fatal.
func (o *DB) gcSweep(ctx context.Context, cutoff, window int, what string, keys func(g int) []string) error {
	for g := cutoff; g > cutoff-window && g >= 1; g-- {
		for _, key := range keys(g) {
			if err := o.Rm(ctx, key); err != nil {
				return fmt.Errorf("gc %s %d: %w", what, g, err)
			}
		}
	}
	return nil
}

// gcMaxSweep bounds how many tail generations one GCLatest run clears, so a
// large one-time backlog (a long-missed sweep, a big --max-deltas reduction, or
// the first run on a store that predates the GCLatestSwept low-water) drains
// over several runs instead of issuing thousands of sequential store deletes in
// a single fetch cycle. It comfortably covers every normal single-run jump — a
// consolidation advance plus one missed sweep plus a --max-deltas reset — so
// steady state and the common recovery cases clear in one run.
const gcMaxSweep = 64

// GCLatest deletes superseded tail generations — the L<g> packs of all three
// series AND the d<g> delta segments — keeping a grace window for readers
// holding a stale db.gz. The cutoff is tailGen-based, NOT Seq-based: with a
// live delta chain Seq runs ahead of the tail generation, and a Seq-based
// cutoff would delete the CURRENT tail packs. Beyond the classic `keep` commits
// of staleness the cutoff also backs off by 2·maxDeltas: a tab `keep` commits
// stale can hold a tailGen up to 2·(maxDeltas+1) generations behind (each of
// its ≤ keep missed commits may be a consolidation jumping tailGen by up to
// maxDeltas+1), so anything above the cutoff must be kept — sufficient for
// keep >= 1, and exactly the pre-delta cutoff at the MaxDeltas=0 kill switch.
//
// The sweep is a LOW-WATER drain, not a fixed trailing window: it clears
// (GCLatestSwept, cutoff] and advances GCLatestSwept only over generations it
// actually cleared. tailGen JUMPS at consolidation (by up to maxDeltas+1) and
// the cutoff jumps with it (and can jump further when --max-deltas is lowered),
// so a fixed trailing window would strand every name inside a jump larger than
// the window — and a single missed/failed sweep (GC is warn-only, post-Commit)
// would strand them permanently, since no later run's window would reach back
// that far. The low-water mark closes that gap: the next advancing run resumes
// from exactly where the last stopped, so nothing is ever permanently stranded,
// regardless of jump size or a --max-deltas change. Per-run work is capped at
// gcMaxSweep generations; a larger backlog drains across runs. Rm is silent on
// missing keys, so sweeping names a generation never wrote (d<g> at a
// consolidation g, L<g> at a delta g) costs nothing.
func (o *DB) GCLatest(ctx context.Context, keep int) error {
	c := &o.core
	cutoff := tailGen(c) - keep - 1 - 2*globals.MaxDeltas
	from := max(c.GCLatestSwept+1, 1)
	to := min(cutoff, from+gcMaxSweep-1)
	// Advance the low-water only over generations fully cleared, so a mid-sweep
	// Rm error (or a to < from no-op when a raised --max-deltas dropped the
	// cutoff below what's already swept) never marks an un-deleted name as
	// reclaimed.
	swept := c.GCLatestSwept
	for g := from; g <= to; g++ {
		// Pre-meta generations never wrote a meta/L name; a delta generation
		// wrote no L<g> and a consolidation generation wrote no d<g>, and only
		// consolidation generations wrote a db/<g> snapshot — Rm is silent on
		// missing keys, so sweeping every name unconditionally costs nothing.
		for _, key := range []string{genKey("idx", g), genKey("data", g), genKey("meta", g), deltaKey(g), dbSnapshotKey(g)} {
			if err := o.Rm(ctx, key); err != nil {
				c.GCLatestSwept = swept
				return fmt.Errorf("gc latest generation %d: %w", g, err)
			}
		}
		swept = g
	}
	c.GCLatestSwept = swept
	return nil
}

// GCSummaries deletes superseded idx header summaries (idx/h<g>.gz) with the
// same grace window. Unlike Seq, HdrPacks advances by the number of packs
// finalized in a batch, so a >1 jump can strand an old summary outside every
// future window — a harmless ~1KB-per-50k-articles leak; the reader treats a
// missing summary by falling back to eager idx loading, so nothing
// user-visible depends on this sweep.
func (o *DB) GCSummaries(ctx context.Context, keep int) error {
	return o.gcSweep(ctx, o.core.HdrPacks-keep-1, gcSweepWindow, "idx summary", func(g int) []string {
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

// PutArticles persists the batch and returns the ArticleData it wrote, in
// pack order — SyncMeta consumes that slice, so derived meta entries can never
// drift from the packs. Accounting (TotalArticles, per-feed TotalArt /
// ContentBytes) runs HERE, exactly once per article at ingest time; pack
// materialization runs either now (a consolidation cycle: this batch plus the
// live delta chain replay through consolidateTail) or later (a delta cycle:
// the batch publishes as one immutable delta segment and a future
// consolidation materializes it).
func (o *DB) PutArticles(ctx context.Context, articles []*Item) ([]ArticleData, error) {
	if len(articles) == 0 {
		return nil, nil
	}
	c := &o.core
	o.consolidated = nil

	prevTotal := c.TotalArticles
	written := make([]ArticleData, 0, len(articles))
	lines := make([][]byte, 0, len(articles))
	var batchBytes int64
	for _, item := range articles {
		ad := item.articleData(c.FetchedAt)
		line, err := jsonEncode(&ad)
		if err != nil {
			return nil, err
		}
		written = append(written, ad)
		lines = append(lines, line)
		batchBytes += int64(len(line))
		c.TotalArticles++
		item.Feed.TotalArt++
		item.Feed.ContentBytes += int64(len(line))
	}

	if o.shouldConsolidate(prevTotal, c.TotalArticles, batchBytes) {
		if err := o.consolidateTail(ctx, written, lines, prevTotal); err != nil {
			return nil, err
		}
	} else {
		// The pre-delta writer loaded+validated the tail idx on every cycle (it
		// had to, to append). A delta cycle never touches the tail, so a
		// corrupt/truncated consolidated tail — a non-atomic backend's partial
		// prior consolidation, or store tampering — would otherwise go unseen by
		// the writer until the next consolidation up to maxDeltas cycles later,
		// while every reader is already failing to parse it. Re-validate it here
		// so real corruption fails fast and loud, near its cause, instead of
		// green fetch logs during the whole window readers are broken.
		if err := o.checkTailIntact(ctx, prevTotal-c.DeltaArticles); err != nil {
			return nil, err
		}
		if err := o.emitDelta(ctx, lines, len(written), batchBytes); err != nil {
			return nil, err
		}
		// SyncMeta skips delta cycles (tailCovered is unmoved), so the delta
		// path maintains the newest-glance head projection itself — it has the
		// cards in hand and db.gz is rewritten every cycle anyway.
		c.extendHead(written)
	}
	return written, nil
}

// checkTailIntact re-validates the consolidated tail idx pack against db.gz on a
// delta cycle (tc is the tail-covered count, unchanged by a delta). A transient
// READ failure only warns — the delta itself doesn't depend on the tail, so a
// blip must not discard a durable batch — but a structural MISMATCH is fatal, as
// it was for the pre-delta writer's per-cycle checkLatestIdx. Skipped when the
// tail idx holds no entries (an all-delta store, or tc exactly on a 50k
// boundary): there is nothing the consolidation's own check didn't already
// cover.
func (o *DB) checkTailIntact(ctx context.Context, tc int) error {
	if latestIdxEntryCount(tc) == 0 {
		return nil
	}
	idxKey := latestKey(&o.core, "idx")
	raw, err := o.loadPack(ctx, idxKey)
	if err != nil {
		slog.Warn("delta cycle: could not read tail idx to validate; skipping check", "key", idxKey, "error", err)
		return nil
	}
	if _, err := checkLatestIdx(idxKey, raw, tc); err != nil {
		return fmt.Errorf("consolidated tail idx corrupt (readers are already failing to parse it): %w", err)
	}
	return nil
}

// shouldConsolidate decides a dirty cycle's path. The chain cap and byte cap
// bound a cold reader's extra requests/bytes; the boundary force upholds
// invariant I2 — no 5k meta stratum (and, since 5000 | 50000, no 50k idx
// boundary) ever lies strictly inside the delta region, so the reader's
// numFinalized* formulas keep working verbatim on total_art. The data-pack
// byte boundary is deliberately NOT checked here: data packs roll inside
// materialization, exactly as a large batch rolls them. MaxDeltas <= 0 is the
// kill switch: every dirty cycle consolidates — byte-identical behavior to
// the pre-delta writer (pinned by the consolidation-equivalence test).
func (o *DB) shouldConsolidate(prevTotal, newTotal int, batchBytes int64) bool {
	c := &o.core
	return globals.MaxDeltas <= 0 ||
		c.NumDeltas >= globals.MaxDeltas ||
		c.DeltaBytes+batchBytes > int64(globals.MaxDeltaBytes)<<10 ||
		numFinalizedMeta(newTotal) > numFinalizedMeta(prevTotal)
}

// emitDelta publishes the batch as one immutable delta segment
// (data/d<Seq+1>.gz, fast gzip like the tail packs) and bumps the chain
// counters. Seq advances only after the save succeeds and Commit publishes it
// — the same "no reader can learn a name before Commit" argument as L<Seq+1>:
// a crash leaves an orphan the retry overwrites, safe under immutable cache
// headers because nothing may speculatively prefetch d<Seq+1>.
func (o *DB) emitDelta(ctx context.Context, lines [][]byte, n int, size int64) error {
	c := &o.core
	p := newPack()
	for _, line := range lines {
		if _, err := p.Write(line); err != nil {
			return err
		}
	}
	if err := o.savePack(ctx, deltaKey(c.Seq+1), p); err != nil {
		return err
	}
	c.Seq++
	c.NumDeltas++
	c.DeltaArticles += n
	c.DeltaBytes += size
	return nil
}

// extendHead appends the batch's meta cards to the head projection on a delta
// cycle. The prior head is extended only when contiguous with the batch (its
// end == the pre-batch total); anything else — an absent head, a stale base
// from an old warn-only SyncMeta failure — starts fresh from the batch alone,
// so Head[i] is always the card at chron HeadBase+i.
func (c *DBCore) extendHead(written []ArticleData) {
	cards := make([]MetaEntry, len(written))
	for i := range written {
		cards[i] = MetaEntry{FeedID: written[i].FeedID, When: written[i].displayTime(), Title: written[i].Title}
	}
	if len(c.Head) > 0 && c.HeadBase+len(c.Head) == c.TotalArticles-len(written) {
		cards = append(append([]MetaEntry(nil), c.Head...), cards...)
	}
	if len(cards) > headMax {
		cards = cards[len(cards)-headMax:]
	}
	c.Head = cards
	c.HeadBase = c.TotalArticles - len(cards)
}

// DrainDeltas consolidates a live delta chain without a new batch, leaving
// the store at nd==0 (a no-op when already there). Feed removal requires it
// (see RemoveFeed); the meta series is synced right away since the replay
// slice is in memory — warn-only, exactly as in the fetch cycle (a failed
// sync heals on the next one).
func (o *DB) DrainDeltas(ctx context.Context) error {
	if o.core.NumDeltas == 0 {
		return nil
	}
	if err := o.consolidateTail(ctx, nil, nil, o.core.TotalArticles); err != nil {
		return err
	}
	if err := o.SyncMeta(ctx, nil); err != nil {
		slog.Warn("sync meta after delta drain", "error", err)
	}
	return nil
}

// loadDeltaChain loads the live delta chain once per cycle and memoizes it on
// (Seq, NumDeltas) — see DB.deltaMemo. It enforces the same chain invariants as
// the read-side loadDeltas (idx_read.go; still the parser inspect/art ls use),
// but additionally captures each entry's verbatim JSONL line bytes so
// consolidateTail can write pre-encoded data-pack bytes.
func (o *DB) loadDeltaChain(ctx context.Context) (*deltaChain, error) {
	c := &o.core
	key := [2]int{c.Seq, c.NumDeltas}
	if o.deltaMemo != nil && o.deltaMemoKey == key {
		return o.deltaMemo, nil
	}
	if c.NumDeltas < 0 || c.DeltaArticles < 0 || c.NumDeltas > c.Seq ||
		c.DeltaArticles > c.TotalArticles || (c.NumDeltas == 0) != (c.DeltaArticles == 0) {
		return nil, fmt.Errorf("inconsistent delta chain: nd=%d na=%d seq=%d total_art=%d",
			c.NumDeltas, c.DeltaArticles, c.Seq, c.TotalArticles)
	}
	chain := &deltaChain{
		Arts:  make([]ArticleData, 0, c.DeltaArticles),
		Lines: make([][]byte, 0, c.DeltaArticles),
	}
	for g := tailGen(c) + 1; g <= c.Seq; g++ {
		key := deltaKey(g)
		buf, err := o.readGz(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", key, err)
		}
		lines, arts, err := splitDataPack(buf)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		if len(arts) == 0 {
			return nil, fmt.Errorf("%s: empty delta segment", key)
		}
		chain.Arts = append(chain.Arts, arts...)
		chain.Lines = append(chain.Lines, lines...)
	}
	if len(chain.Arts) != c.DeltaArticles {
		return nil, fmt.Errorf("delta chain holds %d articles but db.gz na=%d", len(chain.Arts), c.DeltaArticles)
	}
	o.deltaMemo, o.deltaMemoKey = chain, key
	return chain, nil
}

// loadDeltaArticles returns just the parsed articles of the memoized chain
// (walkArticles' seam-crossing tail).
func (o *DB) loadDeltaArticles(ctx context.Context) ([]ArticleData, error) {
	chain, err := o.loadDeltaChain(ctx)
	if err != nil {
		return nil, err
	}
	return chain.Arts, nil
}

// consolidateTail folds the live delta chain plus this cycle's batch into the
// pack series: it replays the parsed deltas ++ batch through the exact
// materialization loop the pre-delta writer ran per cycle — finalizing 50k
// idx packs and PackSize data packs at their boundaries — then publishes the
// new tail generation L<Seq+1> and resets the chain. With MaxDeltas=0 (every
// dirty cycle consolidates, no deltas ever) this IS the pre-delta
// PutArticles, byte for byte.
//
// ⚠ The as-of-chron header subtlety: writeIdxHeader must snapshot per-feed
// cumulative counts AS OF the pack's first chron. Accounting for replayed
// articles ran in their own cycles, so Feed.TotalArt is already at end-state —
// the replay seeds cnt by subtracting each entry's not-yet-replayed
// occurrence, then bumps cnt per article, restoring end-state by the last one.
// The consolidation-equivalence test exists first and foremost for this.
func (o *DB) consolidateTail(ctx context.Context, batch []ArticleData, batchLines [][]byte, prevTotal int) error {
	c := &o.core
	tc0 := prevTotal - c.DeltaArticles

	chain, err := o.loadDeltaChain(ctx)
	if err != nil {
		return fmt.Errorf("consolidate: %w", err)
	}
	// entries drives the replay (idx entries, boundaries, counts, meta);
	// entryLines carries each entry's verbatim JSONL bytes so the data packs are
	// written pre-encoded instead of re-encoding every ArticleData (identical
	// bytes — jsonEncode is deterministic — so the equivalence test still holds).
	// Fresh slices so the append never aliases the memoized chain.
	entries := make([]ArticleData, 0, len(chain.Arts)+len(batch))
	entries = append(append(entries, chain.Arts...), batch...)
	entryLines := make([][]byte, 0, len(chain.Lines)+len(batchLines))
	entryLines = append(append(entryLines, chain.Lines...), batchLines...)

	idxKey := latestKey(c, "idx")
	metaRaw, err := o.loadPack(ctx, idxKey)
	if err != nil {
		return err
	}
	entriesEnd, err := checkLatestIdx(idxKey, metaRaw, tc0)
	if err != nil {
		return err
	}
	dataRaw, err := o.loadPack(ctx, latestKey(c, "data"))
	if err != nil {
		return err
	}
	data, err := packFromBytes(dataRaw)
	if err != nil {
		return err
	}

	// The latest idx pack = header ‖ entries ‖ u16-boundary footer. Appending
	// means dropping the old footer, keeping header+entries, recovering the
	// boundary list, then re-emitting it at save. localIdx is the next entry's
	// position within the current latest idx pack; boundaries holds the local
	// indices at which the data packId has advanced. entriesEnd (from
	// checkLatestIdx, 0 on an empty store) is where the entries end and the
	// old footer begins.
	var boundaries []int
	localIdx := latestIdxEntryCount(tc0)
	meta := newPack()
	if entriesEnd > 0 {
		boundaries = parseIdxFooter(metaRaw[entriesEnd:])
		if _, err := meta.Write(metaRaw[:entriesEnd]); err != nil {
			return err
		}
	}

	// Rewind the count vector to the replay's start (see the doc comment). A
	// slot only tracks a LIVE feed: a feed removed while its articles sat in
	// the chain contributes nothing (matching the old map-driven header, which
	// dropped removed feeds), and an id freed+reused mid-chain can underflow —
	// clamp with a warning rather than wedge the fetch loop forever.
	cnt := liveCounts(c.Feeds)
	live := make([]bool, len(cnt))
	for id := range c.Feeds {
		live[id] = true
	}
	for i := range entries {
		if f := entries[i].FeedID; f >= 0 && f < len(cnt) && live[f] {
			if cnt[f] == 0 {
				slog.Warn("consolidate: feed id reused while the chain held its old articles; its header counts are approximate",
					"feed_id", f)
				live[f] = false
				continue
			}
			cnt[f]--
		}
	}

	prevPackID := c.NextPackID
	mTotal := tc0

	for i := range entries {
		ad := &entries[i]
		if mTotal > 0 && mTotal%idxPackSize == 0 {
			if err := writeIdxFooter(meta, boundaries); err != nil {
				return err
			}
			if err := o.savePackFinal(ctx, finalizedIdxKey(mTotal/idxPackSize-1), meta); err != nil {
				return err
			}
			// savePackFinal resets meta; the next entry starts a fresh idx pack.
			boundaries = nil
			localIdx = 0
		}

		if meta.Len() == 0 {
			if err := writeIdxHeader(meta, c.NextPackID, c.PackOffset, cnt); err != nil {
				return err
			}
		}

		if data.Len() > 0 && data.Len() >= globals.PackSize<<10 {
			if err := o.savePackFinal(ctx, finalizedDataKey(c.NextPackID), data); err != nil {
				return err
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
		if err := meta.writeIdx(ad.FeedID); err != nil {
			return err
		}
		localIdx++
		prevPackID = c.NextPackID

		// Pre-encoded bytes from the delta segment / batch — byte-identical to
		// re-running the deterministic jsonEncode on ad, minus the CPU (see
		// entryLines above).
		if _, err := data.Write(entryLines[i]); err != nil {
			return err
		}
		if f := ad.FeedID; f >= 0 && f < len(cnt) && live[f] {
			cnt[f]++
		}
		mTotal++
		c.PackOffset++
	}
	if mTotal != c.TotalArticles {
		return fmt.Errorf("consolidate: replayed to %d entries but total_art is %d", mTotal, c.TotalArticles)
	}

	// Seal the latest (non-finalized) idx pack with its boundary footer before
	// saving — same shape as a finalized pack, so the reader's parse is uniform.
	if err := writeIdxFooter(meta, boundaries); err != nil {
		return err
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
	o.prevTailGen = tailGen(c)
	o.consolidated = entries
	c.Seq++
	c.NumDeltas, c.DeltaArticles, c.DeltaBytes = 0, 0, 0
	return nil
}
