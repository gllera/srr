package main

// bench_test.go — the store hot paths, measured (TST5). Everything here was
// previously known only by hand-measurement recorded in a comment: gzipBest's
// "−4% data / −11% idx" (db_pack.go), the "~10s of zopfli CPU per shard" that
// made setupTestDB stub finalGzip out (db_test.go), and consolidation's cost,
// which was never measured at all. A number in a comment cannot regress-test
// itself and cannot be re-run on a different host — and every one of these
// costs is paid on an ARM SBC, inline, while the store write lock is held.
//
// Run them with `make bench-be` (never in `verify` — see the Makefile). Four
// benchmarks, each pointed at a specific open question:
//
//   BenchmarkGzipBest        the GRO5 decision. savePackFinal runs go-zopfli on
//                            every finalized data pack, every 50k idx pack and
//                            every 5k meta shard. Is that CPU buying bytes
//                            worth having, or would stdlib BestCompression do?
//                            Sub-benchmarked per series (they compress nothing
//                            alike: 2-byte LE ids vs prose JSONL vs a random
//                            bloom bitmap) × per encoder, reporting bytes-out
//                            and %-saved-vs-what-savePack-already-wrote next to
//                            ns/op, because the answer is a ratio of the two.
//   BenchmarkConsolidateTail the delta-tail fold (docs/DELTA-TAIL-SPEC.md): a
//                            full chain replayed into fresh tail packs, the
//                            longest single step of a consolidation cycle and
//                            the one that scales with --max-deltas.
//   BenchmarkBloomBuild      one finalized meta shard's bloom pass — fold +
//                            trigram + 7 probes over 5,000 titles, run inside
//                            saveMetaShard for every shard SyncMeta finalizes.
//   BenchmarkFoldSearchText  the folding contract alone (NFD normalize + mark
//                            strip + per-rune lower). It is the inner loop of
//                            the bloom pass above AND is mirrored byte-for-byte
//                            in the reader's search.ts, so its cost is the
//                            budget both sides live inside.
//
// Fixtures are built INSIDE the benchmark functions, never at package init and
// never in a TestXxx: `go test ./...` must not pay a cent of this. They reuse
// genbig_test.go's deterministic content generator (loremArticle, feedName,
// feedWeight) so the bytes being compressed and replayed are shaped like the
// ones production writes — long-tailed feed volume, real article markup —
// rather than like a compressibility benchmark's idea of text.

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"sort"
	"testing"
)

// benchFeeds is the feed count every fixture here draws from — genbig_test.go's
// floor, comfortably above the ~71 the production store carries, so the idx
// header's numSlots vector and the feed_id entropy in the entries are both at
// least as demanding as reality.
const benchFeeds = 150

// benchPickFeed maps an absolute article index to a feed id under
// genbig_test.go's long-tailed weight distribution (a few high-volume wires, a
// long tail of blogs). Round-robin would make the idx entry stream perfectly
// periodic — the single most compressible thing it could possibly be, which is
// exactly the wrong input for a compression benchmark.
func benchPickFeed(cum []int, gidx int) int {
	r := &genRand{s: 0x6a09e667f3bcc908 + uint64(gidx)}
	pick := int(r.next() % uint64(cum[len(cum)-1]))
	return sort.Search(len(cum)-1, func(i int) bool { return cum[i+1] > pick })
}

// benchFeedCum is benchPickFeed's prefix-sum table over benchFeeds feeds.
func benchFeedCum() []int {
	cum := make([]int, benchFeeds+1)
	for i := range benchFeeds {
		cum[i+1] = cum[i] + feedWeight(i)
	}
	return cum
}

// benchIdxPackBytes builds one FULL finalized idx pack (idxPackSize entries)
// through the real writers — variable header, 2-byte LE entries, u16 boundary
// footer — so gzipBest sees the exact byte shape savePackFinal hands it. Data
// packs roll every benchDataRoll entries, which is what puts boundaries in the
// footer; at the default 200 KB pack size and ~2 KB articles that is the real
// cadence.
func benchIdxPackBytes(tb testing.TB) []byte {
	tb.Helper()
	const benchDataRoll = 100
	cum := benchFeedCum()
	counts := make([]uint32, benchFeeds)

	p := newPack()
	if err := writeIdxHeader(p, 0, 0, counts); err != nil {
		tb.Fatal(err)
	}
	var boundaries []int
	for i := range idxPackSize {
		if i > 0 && i%benchDataRoll == 0 {
			boundaries = append(boundaries, i)
		}
		f := benchPickFeed(cum, i)
		if err := p.writeIdx(f); err != nil {
			tb.Fatal(err)
		}
		counts[f]++
	}
	if err := writeIdxFooter(p, boundaries); err != nil {
		tb.Fatal(err)
	}
	if err := p.gz.Close(); err != nil {
		tb.Fatal(err)
	}
	return p.buf.Bytes()
}

// benchDataPackBytes builds one finalized data pack: JSONL ArticleData lines of
// real article markup, filled to the default target size (defaultPackSize KB of
// COMPRESSED bytes, the same `data.Len() >= PackSize<<10` rule the writer rolls
// on).
func benchDataPackBytes(tb testing.TB) []byte {
	tb.Helper()
	cum := benchFeedCum()
	p := newPack()
	for i := 0; p.Len() < defaultPackSize<<10; i++ {
		title, content := loremArticle(i)
		ad := ArticleData{
			FeedID:    benchPickFeed(cum, i),
			FetchedAt: 1_600_000_000 + int64(i/64)*3600,
			Published: 1_600_000_000 + int64(i)*300,
			Title:     title,
			Link:      fmt.Sprintf("https://%s.example.com/%s", feedSlug(i%benchFeeds), slugify(title)),
			Content:   content,
			Lang:      []string{"", "es", "en"}[i%3],
		}
		line, err := jsonEncode(&ad)
		if err != nil {
			tb.Fatal(err)
		}
		if _, err := p.Write(line); err != nil {
			tb.Fatal(err)
		}
	}
	if err := p.gz.Close(); err != nil {
		tb.Fatal(err)
	}
	return p.buf.Bytes()
}

// benchMetaEntries is one finalized shard's worth of meta cards (metaPackSize),
// titles drawn from the same generator as the data pack so the two fixtures
// describe one coherent store.
func benchMetaEntries() []MetaEntry {
	cum := benchFeedCum()
	out := make([]MetaEntry, metaPackSize)
	for i := range out {
		title, _ := loremArticle(i)
		out[i] = MetaEntry{
			FeedID: benchPickFeed(cum, i),
			When:   1_600_000_000 + int64(i)*300,
			Title:  title,
		}
	}
	return out
}

// benchMetaShardBytes builds one finalized meta shard exactly as saveMetaShard
// does: the 4 KB bloom, then the JSONL cards. The bloom half matters to the
// compression question on its own — it is a saturated random bitmap, i.e. 4 KB
// of incompressible noise sitting in front of very compressible text.
func benchMetaShardBytes(tb testing.TB) []byte {
	tb.Helper()
	bloom := make([]byte, searchBloomBytes)
	p := newPack()
	entries := benchMetaEntries()
	lines := make([][]byte, len(entries))
	for i := range entries {
		eachSearchGram(foldSearchText(entries[i].Title), func(gram string) { bloomAdd(bloom, gram) })
		line, err := jsonEncode(&entries[i])
		if err != nil {
			tb.Fatal(err)
		}
		lines[i] = line
	}
	if _, err := p.Write(bloom); err != nil {
		tb.Fatal(err)
	}
	for _, line := range lines {
		if _, err := p.Write(line); err != nil {
			tb.Fatal(err)
		}
	}
	if err := p.gz.Close(); err != nil {
		tb.Fatal(err)
	}
	return p.buf.Bytes()
}

// gzipLevel is the stdlib alternative gzipBest is being weighed against:
// gunzip, then re-deflate at the given level. Same shape as gzipBest (which
// also gunzips its input first), so the two ns/op are directly comparable and
// the difference is deflate effort and nothing else.
func gzipLevel(level int, gz []byte) ([]byte, error) {
	raw, err := gunzip(bytes.NewReader(gz))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	w, err := gzip.NewWriterLevel(&out, level)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(raw); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// BenchmarkGzipBest answers GRO5: savePackFinal spends go-zopfli CPU on every
// finalized object, inline, under the store write lock, on an ARM SBC. What
// does that buy, per series, against the stdlib encoder?
//
// Read the output as a RATIO, not as ns/op. Three numbers per row:
//
//	ns/op       wall cost of one finalized object of that series
//	bytes-out   what gets published (and downloaded forever, by every reader)
//	%-saved     against the bytes savePack ALREADY produced at the stdlib
//	            default level — the do-nothing baseline, since a tail pack that
//	            is later finalized was already compressed once at that level.
//
// The `-default` row is that baseline re-measured, so its %-saved is 0 by
// construction and its ns/op is the price of the compression the writer cannot
// avoid. The decision GRO5 has to make is whether zopfli's %-saved minus
// stdlib-best's %-saved is worth zopfli's ns/op minus stdlib-best's.
//
// ⚠ One caveat on the idx row before anyone quotes it. gzipBest's own comment
// records −11% on idx packs (measured by hand 2026-06-12) and this fixture
// reproduces far less, because an idx pack is nothing but 50,000 feed ids and
// its compressibility is entirely a property of how they are ORDERED. The
// fixture draws them from genbig_test.go's long-tailed weight distribution —
// the repo's own model of a realistic store — but a production pack is written
// from a batch sorted by publication time, which clusters each feed's items
// into runs the generator does not produce. So treat the idx row as a lower
// bound on zopfli's win, and confirm against a real pack (`gzipBest` on bytes
// pulled from cdn.llera.eu) before deciding GRO5 on it. The data and meta rows
// carry real article bytes and need no such asterisk.
func BenchmarkGzipBest(b *testing.B) {
	series := []struct {
		name string
		key  string // gzipBest takes it only to name errors; it steers nothing
		gz   []byte
	}{
		{"idx", "idx/0.gz", benchIdxPackBytes(b)},
		{"data", "data/0.gz", benchDataPackBytes(b)},
		{"meta", "meta/0.gz", benchMetaShardBytes(b)},
	}
	encoders := []struct {
		name string
		fn   func(key string, gz []byte) ([]byte, error)
	}{
		{"zopfli", gzipBest},
		{"stdlib-best", func(_ string, gz []byte) ([]byte, error) { return gzipLevel(gzip.BestCompression, gz) }},
		{"stdlib-default", func(_ string, gz []byte) ([]byte, error) { return gzipLevel(gzip.DefaultCompression, gz) }},
	}

	for _, s := range series {
		raw, err := gunzip(bytes.NewReader(s.gz))
		if err != nil {
			b.Fatal(err)
		}
		for _, e := range encoders {
			b.Run(s.name+"/"+e.name, func(b *testing.B) {
				var out []byte
				b.SetBytes(int64(len(raw)))
				b.ReportAllocs()
				for b.Loop() {
					if out, err = e.fn(s.key, s.gz); err != nil {
						b.Fatal(err)
					}
				}
				// Constants for the whole run, so they are reported as-is
				// rather than per-iteration.
				b.ReportMetric(float64(len(out)), "bytes-out")
				b.ReportMetric(100*(1-float64(len(out))/float64(len(s.gz))), "%-saved")
				b.ReportMetric(float64(len(raw))/float64(len(out)), "x-ratio")
			})
		}
	}
}

// benchConsolidateStore builds a store carrying a full live delta chain and
// returns it ready for one consolidateTail call. Every consolidation replays
// the WHOLE chain, so this is the shape --max-deltas trades against: raising
// the cap saves cycles but makes each consolidation proportionally longer.
//
// finalGzip is stubbed to identity for the same reason setupTestDB stubs it —
// zopfli would dominate the measurement completely, and it is measured on its
// own above. What is left is the replay itself: chain parse, as-of-chron count
// vector, idx entries and boundaries, pre-encoded data lines, pack rolls.
func benchConsolidateStore(b *testing.B, segments, perSegment int) *DB {
	b.Helper()
	globals = &Globals{
		PackSize:    defaultPackSize,
		Store:       b.TempDir(),
		Workers:     1,
		MaxFeedSize: defaultMaxFeedSize,
		CacheDir:    b.TempDir(),
		// A chain cap and byte cap far above what this fixture produces, so
		// every batch below takes the delta path and the chain is exactly
		// `segments` long when the measured consolidation runs.
		MaxDeltas:     segments + 1,
		MaxDeltaBytes: 1 << 20,
	}
	finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
	metaTailMemo.reset()
	b.Cleanup(func() { finalGzip = gzipBest })

	db, err := NewDB(ctx, false)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { db.Close(ctx) })

	feeds := make([]*Feed, benchFeeds)
	for i := range feeds {
		feeds[i] = &Feed{Title: feedName(i), URL: fmt.Sprintf("https://%s.example.com/feed.xml", feedSlug(i))}
		if err := db.AddFeed(feeds[i]); err != nil {
			b.Fatal(err)
		}
	}

	// A consolidated base first (MaxDeltas=0 forces it), so the measured call
	// APPENDS to real tail packs — loading them, stripping the idx footer and
	// recovering its boundaries — instead of starting from an empty store,
	// which is the one case production essentially never runs.
	cum := benchFeedCum()
	gidx := 0
	putBatch := func(cycle, n int) {
		db.core.FetchedAt = 1_600_000_000 + int64(cycle)*3600
		batch := make([]*Item, n)
		for i := range batch {
			title, content := loremArticle(gidx)
			batch[i] = &Item{
				Feed:      feeds[benchPickFeed(cum, gidx)],
				Title:     title,
				Content:   content,
				Link:      fmt.Sprintf("https://example.com/a/%d", gidx),
				Published: 1_600_000_000 + int64(gidx)*300,
			}
			gidx++
		}
		if _, err := db.PutArticles(ctx, batch); err != nil {
			b.Fatal(err)
		}
	}
	saved := globals.MaxDeltas
	globals.MaxDeltas = 0
	putBatch(0, perSegment*segments)
	globals.MaxDeltas = saved

	for s := range segments {
		putBatch(s+1, perSegment)
	}
	if got := db.core.numDeltas(); got != segments {
		b.Fatalf("fixture built %d delta segment(s), want %d", got, segments)
	}
	return db
}

// BenchmarkConsolidateTail measures one delta-chain fold — the step that turns
// `maxDeltasDefault` cycles' worth of immutable delta segments into fresh tail
// packs (docs/DELTA-TAIL-SPEC.md). It is the longest single step of a
// consolidation cycle and it runs with the store write lock held, so it is
// also a direct input to how close a cycle can come to leaseTTL.
//
// The chain is rebuilt from scratch per iteration (consolidateTail is a
// one-shot state transition — it empties the chain it folds), with the rebuild
// outside the timer.
func BenchmarkConsolidateTail(b *testing.B) {
	// maxDeltasDefault segments of a batch size a busy 150-feed store produces
	// in five minutes: the steady-state consolidation, not a backfill.
	const segments, perSegment = maxDeltasDefault, 40

	for b.Loop() {
		b.StopTimer()
		db := benchConsolidateStore(b, segments, perSegment)
		total := db.core.TotalArticles
		b.StartTimer()

		if err := db.consolidateTail(ctx, nil, nil, total); err != nil {
			b.Fatal(err)
		}

		b.StopTimer()
		if db.core.numDeltas() != 0 {
			b.Fatal("consolidateTail left the chain non-empty")
		}
		if err := db.Close(ctx); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
	}
	b.ReportMetric(float64(segments*perSegment), "articles/op")
}

// BenchmarkBloomBuild measures one finalized meta shard's bloom pass: fold
// every title, cut it into rune trigrams, set 7 bits per gram. saveMetaShard
// runs it for every shard SyncMeta finalizes, and `srr inspect --validate`
// re-runs it for every shard in the store — so on a 1M-article store this is
// 200 executions of it, in a loop, on the same box that serves the admin GUI.
func BenchmarkBloomBuild(b *testing.B) {
	entries := benchMetaEntries()
	var grams, chars int64
	for i := range entries {
		folded := foldSearchText(entries[i].Title)
		chars += int64(len(folded))
		eachSearchGram(folded, func(string) { grams++ })
	}

	b.SetBytes(chars)
	b.ReportAllocs()
	for b.Loop() {
		bloom := make([]byte, searchBloomBytes)
		for i := range entries {
			eachSearchGram(foldSearchText(entries[i].Title), func(gram string) { bloomAdd(bloom, gram) })
		}
	}
	b.ReportMetric(float64(grams), "grams/op")
	b.ReportMetric(float64(len(entries)), "titles/op")
}

// benchFoldCorpus is the folding contract's real input mix. Plain ASCII is the
// cheap case and would flatter the measurement: foldSearchText's cost is
// dominated by norm.NFD decomposing precomposed accents and by the per-rune
// path once anything is multi-byte, and the reader's search.ts pays the mirror
// of exactly that on every keystroke.
var benchFoldCorpus = []string{
	"The Cobalt Tribune reports on quarterly earnings",
	"Ελληνικά νέα: η τελική σίγμα δοκιμή ΣΙΓΜΑΣ",
	"Präsident kündigt Maßnahmen an — Straße gesperrt",
	"Ñandú, jalapeño y açaí: guía de pronunciación",
	"日本語のタイトル、スペースなしの長い連続",
	"Ünïcödé   punctuation!!  (parenthesised) [bracketed] 12345",
	"İstanbul'da ŞEHİR içi ulaşım — ğüşıöç",
	"plain ascii headline with nothing interesting in it at all",
}

// BenchmarkFoldSearchText measures the folding contract alone (db_meta.go
// foldSearchText). It is the inner loop of BenchmarkBloomBuild above, and it is
// mirrored byte-for-byte by frontend/src/js/search.ts fold() — so this number
// is the budget BOTH sides of the search contract live inside, and any change
// to the fold has to be weighed here before it is weighed anywhere else.
func BenchmarkFoldSearchText(b *testing.B) {
	var chars int64
	for _, s := range benchFoldCorpus {
		chars += int64(len(s))
	}
	b.SetBytes(chars)
	b.ReportAllocs()
	for b.Loop() {
		for _, s := range benchFoldCorpus {
			if foldSearchText(s) == "" {
				b.Fatal("empty fold")
			}
		}
	}
}
