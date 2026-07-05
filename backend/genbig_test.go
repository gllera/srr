package main

// genbig_test.go — synthetic large-store generator for performance and
// format-stress testing of the binary idx pack format across the 50,000-entry
// pack boundary (idxPackSize). It is NOT a unit test: it is skipped unless
// SRR_GENBIG_OUT names an output directory, so `go test ./...` / `make verify`
// never run it. It drives the REAL production write path
// (PutArticles → SyncIdxSummary → SyncMeta → Commit, the same order and the
// same functions cmd_fetch uses), so the store it emits is byte-compatible
// with one a live fetch loop would produce — just deterministic and large.
//
// What it stresses:
//   - >50,000 articles finalize idx/0.gz mid-batch (db_pack.go) and grow more
//     packs, exercising the variable-length header, the u16 boundary footer,
//     multi-shard meta, and the idx header summary.
//   - >=150 feeds (default 150 + later waves) with feed_ids interleaved inside
//     every batch make the cumulative header counts and footer boundaries
//     non-trivial; waves add feeds AFTER packs finalize, reproducing the
//     "feed absent from an earlier pack / numSlots grows per generation" case.
//   - STOP/RESUME: production fetches in cycles, each one re-opening the store
//     and appending to the committed latest pack. This generator does the same
//     — it Closes and re-opens the DB (NewDB re-reads db.gz from disk) several
//     times mid-run (SRR_GENBIG_SESSIONS), so the cross-cycle resume path
//     (load latest pack, strip footer, recover boundaries via parseIdxFooter,
//     restore seq/next_pid/pack_off/hdrs/mp/mt, extend) is exercised on every
//     run, not just multi-batch in one open. After each reopen it asserts the
//     reloaded total_art matches, and at the end runs `inspect --validate` —
//     so a resume that corrupts bounds/feed-counts/meta/summary fails loudly.
//   - Realistic articles: publication-style feed names ("The Cobalt Tribune"),
//     long-tailed per-feed volume (feedWeight — a few high-volume wires, a long
//     tail of blogs, NOT round-robin), and bodies with a lead photo, lead
//     paragraph, subheaded sections, pull-quotes, bullet lists, inline links,
//     and real images from https://picsum.photos/ (deterministic seed per
//     image). All deterministic per absolute article index, so a stop/resume
//     run is byte-identical to a single-shot run — any divergence is a bug.
//
// Usage (from backend/) — always pass -count=1, or `go test` caches the run
// and a repeated invocation becomes a silent no-op (adds nothing):
//   SRR_GENBIG_OUT=../bigstore go test -run TestGenBigStore -count=1 -timeout 600s .
//   SRR_GENBIG_OUT=../big SRR_GENBIG_N=120000 SRR_GENBIG_FEEDS=200 SRR_GENBIG_SESSIONS=6 \
//       SRR_GENBIG_FORCE=1 go test -run TestGenBigStore -count=1 -timeout 900s .
// Resume across separate invocations (no FORCE => append to the existing store):
//   SRR_GENBIG_OUT=../big SRR_GENBIG_N=20000 go test -run TestGenBigStore -count=1 .  # +20k/run
// Then verify / serve:
//   ./dist/srr -o bigstore inspect --validate
//   SRR_STORE=$PWD/bigstore make dev-fe        # serve to the real reader
//
// Env knobs (all optional except SRR_GENBIG_OUT):
//   SRR_GENBIG_OUT        output store dir (required; relative to backend/ cwd)
//   SRR_GENBIG_N          articles to ADD this invocation   (default 60000)
//   SRR_GENBIG_FEEDS      initial feed count, floored at 150 (default 150)
//   SRR_GENBIG_SESSIONS   in-process stop/resume cycles      (default 4)
//   SRR_GENBIG_BATCH      articles per PutArticles           (default 4096)
//   SRR_GENBIG_PACKKB     data-pack target KB                (default 200)
//   SRR_GENBIG_ZOPFLI     "1" => real gzipBest on finalized packs (prod-exact
//                         bytes, much slower); default uses fast stdlib gzip.
//   SRR_GENBIG_FORCE      "1" => wipe SRR_GENBIG_OUT first (fresh store); else
//                         an existing store is RESUMED (adds N more articles).
//   SRR_GENBIG_NOVALIDATE "1" => skip the end-of-run inspect --validate sweep.

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func genEnvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// splitmix64 — a tiny deterministic PRNG. Seeded per absolute article index so
// content is a pure function of that index: a stop/resume run produces the same
// bytes as a single-shot run, and regenerations are reproducible for diffing.
type genRand struct{ s uint64 }

func (r *genRand) next() uint64 {
	r.s += 0x9e3779b97f4a7c15
	z := r.s
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

func (r *genRand) intn(n int) int { return int(r.next() % uint64(n)) }

// loremWords is the classic lorem-ipsum corpus, so titles/bodies read like real
// (if nonsensical) prose and fold into searchable words for the meta bloom.
var loremWords = strings.Fields(`
	lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor
	incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud
	exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute
	irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur
	excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt
	mollit anim id est laborum at vero eos accusamus iusto odio dignissimos
	ducimus blanditiis praesentium voluptatum deleniti corrupti quos dolores
`)

// imgDims are common article-image sizes; picsum.photos serves any requested
// dimensions, so real photos render at realistic aspect ratios.
var imgDims = [][2]int{{1200, 675}, {1024, 576}, {800, 600}, {800, 533}, {960, 540}}

// nameRoots / nameSuffix build realistic publication names ("Meridian Herald",
// "The Cobalt Tribune") — what the reader actually shows for a feed.
var nameRoots = strings.Fields(`
	Meridian Cobalt Harbor Summit Vanguard Atlas Beacon Sterling Granite Cypress
	Northwind Brightwater Ironwood Silverline Riverstone Fairview Lakeshore Highland
	Crestview Redwood Amber Crimson Golden Coastal Capital Metro Union Liberty Pioneer
	Heritage Apex Sentinel Cardinal Juniper Hudson Aurora Pinewood Westgate Clearwater
`)
var nameSuffix = strings.Fields(`
	Times Herald Tribune Post Daily Review Journal Gazette Dispatch Chronicle Wire
	Report Observer Bulletin Ledger Standard Courier Press Digest Today Weekly Monitor
`)
var refDomains = []string{"example.org", "ref.example.net", "wiki.example.com", "docs.example.io", "blog.example.dev"}
var feedTags = []string{"", "news", "tech", "sports", "science", "culture", "business", "world"}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func titleCase(words []string) string {
	out := make([]string, len(words))
	for i, w := range words {
		out[i] = capitalize(w)
	}
	return strings.Join(out, " ")
}

// slugify turns a phrase into a url-safe slug ("The Meridian Herald" ->
// "the-meridian-herald") for realistic feed domains and article paths.
func slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, c := range strings.ToLower(s) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(c)
			dash = false
		} else {
			dash = true
		}
	}
	return b.String()
}

func (r *genRand) words(n int) []string {
	w := make([]string, n)
	for i := range w {
		w[i] = loremWords[r.intn(len(loremWords))]
	}
	return w
}

func (r *genRand) phrase(n int) string { return strings.Join(r.words(n), " ") }

// sentence: a capitalized, period-terminated run of words, with an occasional
// comma so paragraphs don't read as one flat list.
func (r *genRand) sentence() string {
	n := 6 + r.intn(12)
	w := r.words(n)
	for i := 1; i < n-1; i++ {
		if r.intn(7) == 0 {
			w[i] += ","
		}
	}
	return capitalize(strings.Join(w, " ")) + "."
}

func (r *genRand) paragraph(sentences int) string {
	s := make([]string, sentences)
	for i := range s {
		s[i] = r.sentence()
	}
	return strings.Join(s, " ")
}

// feedName / feedSlug are deterministic per feed id (so titles/domains are
// stable across reopens).
func feedName(id int) string {
	r := &genRand{s: uint64(id)*0x2545f4914f6cdd1d + 0x9e3779b9}
	name := nameRoots[r.intn(len(nameRoots))] + " " + nameSuffix[r.intn(len(nameSuffix))]
	if r.intn(2) == 0 {
		name = "The " + name
	}
	return name
}

func feedSlug(id int) string { return slugify(feedName(id)) }

// feedWeight gives each feed a stable publishing volume in a long-tailed
// (Zipf-like) spread: ~10% high-volume wires, ~30% medium, ~60% long-tail
// blogs. This is the realistic alternative to round-robin, where every feed
// would get an identical share and a perfectly sequential feed_id pattern.
func feedWeight(id int) int {
	r := &genRand{s: uint64(id)*0x9e3779b97f4a7c15 + 0xabcdef}
	switch r.intn(10) {
	case 0:
		return 40 + r.intn(60) // ~10% heavy
	case 1, 2, 3:
		return 8 + r.intn(16) // ~30% medium
	default:
		return 1 + r.intn(4) // ~60% light
	}
}

// writeFigure appends a <figure> with a real picsum.photos image (deterministic
// per article + index) and a caption.
func writeFigure(b *strings.Builder, r *genRand, gidx, idx int) {
	dim := imgDims[r.intn(len(imgDims))]
	w, h := dim[0], dim[1]
	fmt.Fprintf(b, `<figure><img src="https://picsum.photos/seed/srr%d-%d/%d/%d" alt="%s" width="%d" height="%d"><figcaption>%s</figcaption></figure>`,
		gidx, idx, w, h, titleCase(r.words(3+r.intn(3))), w, h, r.sentence())
}

// loremArticle builds a realistic article body: a lead photo, a lead paragraph,
// subheaded sections of paragraphs, and occasional pull-quotes, bullet lists,
// inline links, and a second photo — all deterministic from the absolute
// article index, so a stop/resume run reproduces identical bytes.
func loremArticle(gidx int) (title, content string) {
	r := &genRand{s: 0x5252424700000000 + uint64(gidx)}
	title = titleCase(r.words(3 + r.intn(4)))

	var b strings.Builder
	if r.intn(5) != 0 { // ~80% have a lead image
		writeFigure(&b, r, gidx, 0)
	}
	fmt.Fprintf(&b, "<p>%s</p>", r.paragraph(4+r.intn(3)))

	sections := 1 + r.intn(3)
	for s := 0; s < sections; s++ {
		fmt.Fprintf(&b, "<h2>%s</h2>", titleCase(r.words(2+r.intn(3))))
		for p := 0; p < 1+r.intn(3); p++ {
			b.WriteString("<p>")
			b.WriteString(r.paragraph(2 + r.intn(3)))
			if r.intn(3) == 0 {
				dom := refDomains[r.intn(len(refDomains))]
				fmt.Fprintf(&b, ` <a href="https://%s/%s">%s</a>.`, dom, slugify(r.phrase(2+r.intn(2))), r.phrase(2))
			}
			b.WriteString("</p>")
		}
		if r.intn(4) == 0 {
			fmt.Fprintf(&b, "<blockquote><p>%s</p></blockquote>", r.sentence())
		}
		if r.intn(5) == 0 {
			b.WriteString("<ul>")
			for li := 0; li < 2+r.intn(3); li++ {
				fmt.Fprintf(&b, "<li>%s</li>", capitalize(r.phrase(2+r.intn(4))))
			}
			b.WriteString("</ul>")
		}
		if s < sections-1 && r.intn(3) == 0 {
			writeFigure(&b, r, gidx, s+1)
		}
	}
	return title, b.String()
}

func TestGenBigStore(t *testing.T) {
	out := os.Getenv("SRR_GENBIG_OUT")
	if out == "" {
		t.Skip("set SRR_GENBIG_OUT=<dir> to generate a large synthetic store")
	}

	addN := genEnvInt("SRR_GENBIG_N", 60000)
	initFeeds := genEnvInt("SRR_GENBIG_FEEDS", 150)
	if initFeeds < 150 {
		initFeeds = 150 // the store must draw from at least 150 feeds
	}
	sessions := genEnvInt("SRR_GENBIG_SESSIONS", 4)
	batch := genEnvInt("SRR_GENBIG_BATCH", 4096)
	packKB := genEnvInt("SRR_GENBIG_PACKKB", 200)
	force := os.Getenv("SRR_GENBIG_FORCE") == "1"

	// FORCE wipes for a fresh store; otherwise an existing store is resumed.
	if entries, err := os.ReadDir(out); err == nil && len(entries) > 0 && force {
		if err := os.RemoveAll(out); err != nil {
			t.Fatalf("wipe %q: %v", out, err)
		}
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatalf("mkdir %q: %v", out, err)
	}

	globals = &Globals{PackSize: packKB, Store: out}

	// Finalized-pack compression: default to fast stdlib gzip (identity stub —
	// the bytes savePack already produced are valid gzip) so generation is
	// quick; opt into zopfli only when production-exact sizes are wanted.
	if os.Getenv("SRR_GENBIG_ZOPFLI") != "1" {
		finalGzip = func(_ string, gz []byte) ([]byte, error) { return gz, nil }
		t.Cleanup(func() { finalGzip = gzipBest })
	}

	openDB := func() *DB {
		db, err := NewDB(ctx, false)
		if err != nil {
			t.Fatalf("NewDB: %v", err)
		}
		return db
	}

	// feedTarget reports how many feeds should exist by a given article count.
	// The waves land after pack finalizations (~25k into pack 0, ~52k into pack
	// 1, ~102k into pack 2) so feed_ids keep appearing past earlier packs'
	// frozen numSlots — the variable-header growth case.
	feedTarget := func(produced int) int {
		target := initFeeds
		for _, at := range []int{idxPackSize / 2, idxPackSize + idxPackSize/25, 2*idxPackSize + idxPackSize/25} {
			if produced >= at {
				target += 25
			}
		}
		return target
	}
	// ensureFeeds tops the live feed set up to target. AddFeed assigns the
	// lowest free id (dense 0..n-1, no deletes), so the id is predictable and
	// names/tags are stable across reopens. New feeds get add_idx = current
	// total, so they only become visible from that chronIdx on.
	ensureFeeds := func(db *DB, target int) {
		for len(db.core.Feeds) < target {
			id := len(db.core.Feeds)
			f := &Feed{
				Title: feedName(id),
				URL:   fmt.Sprintf("https://%s.example.com/feed.xml", feedSlug(id)),
				Tag:   feedTags[id%len(feedTags)],
			}
			if err := db.AddFeed(f); err != nil {
				t.Fatalf("AddFeed: %v", err)
			}
		}
	}

	const baseFetch int64 = 1_600_000_000 // Sep 2020, safely in the past
	const basePub int64 = 1_600_000_000

	db := openDB()
	startTotal := db.core.TotalArticles
	endTotal := startTotal + addN
	if startTotal > 0 {
		t.Logf("resuming existing store at %d articles; adding %d more", startTotal, addN)
	}

	// Per-feed publishing volume is long-tailed (feedWeight). cum is its prefix
	// sum over every feed this run could create, so a deterministic per-article
	// draw maps to a feed by weighted lookup (sort.Search) — realistic skew
	// instead of round-robin, while staying a pure function of the article
	// index (so resume stays byte-identical).
	maxFeeds := feedTarget(endTotal)
	cum := make([]int, maxFeeds+1)
	for i := 0; i < maxFeeds; i++ {
		cum[i+1] = cum[i] + feedWeight(i)
	}
	pickFeed := func(gidx, feedCount int) int {
		r := &genRand{s: 0x6a09e667f3bcc908 + uint64(gidx)}
		pick := int(r.next() % uint64(cum[feedCount]))
		return sort.Search(feedCount, func(i int) bool { return cum[i+1] > pick })
	}

	// Reopen the DB every batchesPerSession batches to force a real resume.
	estBatches := (addN + batch - 1) / batch
	batchesPerSession := estBatches / sessions
	if batchesPerSession < 1 {
		batchesPerSession = 1
	}

	start := time.Now()
	produced := startTotal
	batchCount := 0
	sessionCount := 1
	for produced < endTotal {
		if batchCount > 0 && batchCount%batchesPerSession == 0 {
			// STOP, then RESUME: closing flushes nothing extra (Commit already
			// published db.gz); reopening rebuilds db.core entirely from the
			// committed db.gz, so the next batch appends through the real
			// cross-cycle resume path.
			if err := db.Close(ctx); err != nil {
				t.Fatalf("Close: %v", err)
			}
			db = openDB()
			sessionCount++
			if db.core.TotalArticles != produced {
				t.Fatalf("resume mismatch: reopened db total_art=%d, expected %d", db.core.TotalArticles, produced)
			}
			t.Logf("↻ resume #%d at %d articles (db.gz reloaded from disk)", sessionCount, produced)
		}

		ensureFeeds(db, feedTarget(produced))
		feedCount := len(db.core.Feeds)

		batchEnd := (produced/batch + 1) * batch
		if batchEnd > endTotal {
			batchEnd = endTotal
		}
		n := batchEnd - produced
		// All articles in one batch share fetched_at, like one fetch cycle. Keyed
		// on the global batch index so it stays a pure function of position.
		db.core.FetchedAt = baseFetch + int64(produced/batch)*3600

		items := make([]*Item, n)
		for i := range items {
			gidx := produced + i
			// Weighted pick across the feeds that exist now (ids dense from 0):
			// heavy feeds get many articles, the long tail few, and feed_ids
			// land in a realistic non-sequential pattern within each idx pack.
			f := db.core.Feeds[pickFeed(gidx, feedCount)]
			title, content := loremArticle(gidx)
			// Published time ascends with chronIdx but with irregular gaps
			// (jitter < the 300s base step keeps it strictly monotonic).
			pub := basePub + int64(gidx)*300 + int64((&genRand{s: 0xc2b2ae3d27d4eb4f + uint64(gidx)}).intn(250))
			tm := time.Unix(pub, 0).UTC()
			items[i] = &Item{
				Feed:      f,
				Title:     title,
				Content:   content,
				Link:      fmt.Sprintf("https://%s.example.com/%d/%02d/%s", feedSlug(f.id), tm.Year(), int(tm.Month()), slugify(title)),
				Published: pub,
			}
		}

		if _, err := db.PutArticles(ctx, items); err != nil {
			t.Fatalf("PutArticles batch %d: %v", batchCount, err)
		}
		if err := db.SyncIdxSummary(ctx); err != nil {
			t.Fatalf("SyncIdxSummary batch %d: %v", batchCount, err)
		}
		// nil forces SyncMeta down the walkArticles reconciliation route (the
		// stricter path: it re-reads the just-written packs), a useful resume
		// cross-check that the committed packs parse back correctly.
		if err := db.SyncMeta(ctx, nil); err != nil {
			t.Fatalf("SyncMeta batch %d: %v", batchCount, err)
		}
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("Commit batch %d: %v", batchCount, err)
		}

		produced = batchEnd
		batchCount++
		if batchCount%5 == 0 || produced == endTotal {
			t.Logf("… %d/%d articles, %d feeds, seq=%d", produced, endTotal, feedCount, db.core.Seq)
		}
	}

	elapsed := time.Since(start)
	c := &db.core
	numFinalizedIdx := 0
	numFinalizedMeta := 0
	if c.TotalArticles > 0 {
		numFinalizedIdx = (c.TotalArticles - 1) / idxPackSize
		numFinalizedMeta = (c.TotalArticles - 1) / metaPackSize
	}
	totalFeeds := len(c.Feeds)
	activeFeeds, maxFeedArt := 0, 0
	for _, ch := range c.Feeds {
		if ch.TotalArt > 0 {
			activeFeeds++
		}
		if ch.TotalArt > maxFeedArt {
			maxFeedArt = ch.TotalArt
		}
	}
	t.Logf("DONE in %s across %d session(s)", elapsed.Round(time.Millisecond), sessionCount)
	t.Logf("  store dir        : %s", out)
	t.Logf("  total_art        : %d (added %d this run)", c.TotalArticles, c.TotalArticles-startTotal)
	t.Logf("  feeds            : %d (%d with articles; busiest has %d, avg %d)", totalFeeds, activeFeeds, maxFeedArt, c.TotalArticles/max(activeFeeds, 1))
	t.Logf("  seq (latest gen) : %d", c.Seq)
	t.Logf("  finalized idx    : %d + latest idx/L%d.gz", numFinalizedIdx, c.Seq)
	t.Logf("  finalized data   : next_pid=%d, pack_off=%d", c.NextPackID, c.PackOffset)
	t.Logf("  finalized meta   : %d shards + latest meta/L%d.gz (mp=%d mt=%d)", numFinalizedMeta, c.Seq, c.MetaPacks, c.MetaTail)
	t.Logf("  idx summary hdrs : %d", c.HdrPacks)

	if err := db.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if activeFeeds < 150 {
		t.Errorf("only %d feeds have articles, want >= 150 (raise SRR_GENBIG_N or SRR_GENBIG_FEEDS)", activeFeeds)
	}

	// Self-check: a full validation sweep over the committed store (reopens via
	// NewDB). A resume that mis-recovered footer boundaries, miscounted
	// feed-counts, or desynced meta/summary fails here.
	if os.Getenv("SRR_GENBIG_NOVALIDATE") != "1" {
		t.Logf("running inspect --validate …")
		if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
			t.Fatalf("inspect --validate: %v", err)
		}
	}
}
