package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log/slog"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// The search/ pack series: title search shards aligned 1:1 with idx packs.
// Finalized shard n (search/<n>.gz) covers chron [n*idxPackSize,
// (n+1)*idxPackSize) as gzip(bloom[searchBloomBytes] ‖ JSONL of SearchEntry);
// the latest shard (search/L<Seq>.gz) holds the tail with no bloom (readers
// always scan it); search/s<N>.gz concatenates the N finalized blooms so the
// reader fetches only shards that can match a query. Design:
// docs/search-design.md. All writing happens here, post-hoc to PutArticles
// (SyncSearch); the frontend reader is frontend/src/js/search.ts.

// SearchEntry is the JSONL line of search/ shards. Line position within the
// shard is the chron offset — no chron is stored.
type SearchEntry struct {
	ChannelID int `json:"s"`
	// When is the display timestamp: published, falling back to fetched_at
	// when unparsed — the same fallback the reader's row rendering wants, so
	// it is precomputed here.
	When  int64  `json:"w"`
	Title string `json:"t,omitempty"`
}

// finalizedSearchKey resolves the key of finalized search shard n.
func finalizedSearchKey(n int) string {
	return fmt.Sprintf("search/%d.gz", n)
}

// searchSummaryKey resolves the search bloom-summary key covering n
// finalized shards.
func searchSummaryKey(n int) string {
	return fmt.Sprintf("search/s%d.gz", n)
}

// foldSearchText is the search folding contract, mirrored byte-for-byte by
// frontend/src/js/search.ts fold() and enforced by the e2e contract test:
// NFD → drop nonspacing marks → lowercase per rune → ς→σ → non-letter/number
// runes separate words → single-space joined. NFD-before-lowercase
// neutralizes the Go-simple vs JS-full case-mapping divergences (İ, ẞ); the
// ς→σ map patches JS's context-sensitive final sigma.
func foldSearchText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	pending := false
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		r = unicode.ToLower(r)
		if r == 'ς' {
			r = 'σ'
		}
		if !unicode.IsLetter(r) && !unicode.IsNumber(r) {
			pending = b.Len() > 0
			continue
		}
		if pending {
			b.WriteRune(' ')
			pending = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// eachSearchGram calls fn for every searchGram-rune sliding window of every
// word in folded (a foldSearchText result). Windows never span word gaps;
// words shorter than searchGram contribute nothing (verification still
// enforces them on the reader side).
func eachSearchGram(folded string, fn func(gram string)) {
	for _, word := range strings.Fields(folded) {
		runes := []rune(word)
		for i := 0; i+searchGram <= len(runes); i++ {
			fn(string(runes[i : i+searchGram]))
		}
	}
}

// bloomBits derives the searchBloomK probe indices of a gram: FNV-1a-64 over
// its UTF-8 bytes, double-hashed as h1=low32, h2=high32|1 (odd, so the probe
// step cycles the power-of-two bit space). Mirrored by search.ts bloomBits().
func bloomBits(gram string) [searchBloomK]uint32 {
	h := fnv.New64a()
	h.Write([]byte(gram))
	sum := h.Sum64()
	h1, h2 := uint32(sum), uint32(sum>>32)|1
	var out [searchBloomK]uint32
	for i := range out {
		out[i] = (h1 + uint32(i)*h2) & (searchBloomBytes*8 - 1)
	}
	return out
}

func bloomAdd(bloom []byte, gram string) {
	for _, b := range bloomBits(gram) {
		bloom[b>>3] |= 1 << (b & 7)
	}
}

func bloomHas(bloom []byte, gram string) bool {
	for _, b := range bloomBits(gram) {
		if bloom[b>>3]&(1<<(b&7)) == 0 {
			return false
		}
	}
	return true
}

// walkArticles streams the articles at chron [from, to) in order, resolving
// (packId, offset) through the idx packs and fetching each idx and data pack
// at most once (chron order keeps data-pack visits monotonic).
func (o *DB) walkArticles(ctx context.Context, from, to int, fn func(ad *ArticleData) error) error {
	c := &o.core
	nf := numFinalizedIdx(c.TotalArticles)
	var data []ArticleData
	dataPackID := -1
	for from < to {
		p := from / idxPackSize
		key, size := finalizedIdxKey(p), idxPackSize
		if p == nf {
			key, size = latestKey(c, "idx"), c.TotalArticles-nf*idxPackSize
		}
		buf, err := o.readGz(ctx, key)
		if err != nil {
			return err
		}
		pack, err := parseIdxPack(buf, p, size)
		if err != nil {
			return fmt.Errorf("parse %s: %w", key, err)
		}
		for end := min(to, p*idxPackSize+size); from < end; from++ {
			packID, off := pack.getPackRef(from)
			if packID != dataPackID {
				dataKey := dataKeyFor(c, packID)
				raw, err := o.readGz(ctx, dataKey)
				if err != nil {
					return err
				}
				if data, err = parseDataPack(raw); err != nil {
					return fmt.Errorf("parse %s: %w", dataKey, err)
				}
				dataPackID = packID
			}
			if off >= len(data) {
				return fmt.Errorf("chron %d: offset %d beyond data pack %d (%d entries)", from, off, packID, len(data))
			}
			if err := fn(&data[off]); err != nil {
				return err
			}
		}
	}
	return nil
}

// SyncSearch reconciles the search/ series with the store whenever db.gz's
// SearchPacks/SearchTail coverage lags TotalArticles: a normal append, a
// pre-search store's first run after upgrade, a post-`srr gen --bump` reset,
// or a retry after a failed sync — one self-healing code path for all of
// them (the SyncIdxSummary philosophy). It extends the previous run's tail
// (search/L<Seq-1>, trusted only when its entry count matches SearchTail)
// with the missing chron range read back from the data packs, finalizing
// bloom-headed shards at each idxPackSize boundary, then writes the new
// latest shard and, when shards were finalized, rebuilds the bloom summary
// from cheap streaming header reads. The coverage fields are set only after
// every save succeeds and the caller's Commit publishes them — so, like
// Seq/HdrPacks, no reader can learn a name before its content is durable.
func (o *DB) SyncSearch(ctx context.Context) error {
	c := &o.core
	if c.TotalArticles == 0 {
		return nil
	}
	nf := numFinalizedIdx(c.TotalArticles)
	if c.SearchPacks == nf && c.SearchPacks*idxPackSize+c.SearchTail == c.TotalArticles {
		return nil
	}
	if c.SearchPacks < 0 || c.SearchPacks > nf || c.SearchTail < 0 || c.SearchTail > idxPackSize ||
		c.SearchPacks*idxPackSize+c.SearchTail > c.TotalArticles {
		slog.Warn("inconsistent search coverage, rebuilding from scratch",
			"srch", c.SearchPacks, "srcht", c.SearchTail, "total_art", c.TotalArticles)
		c.SearchPacks, c.SearchTail = 0, 0
	}

	start := c.SearchPacks * idxPackSize // chron of the tail's first entry
	var rawLines [][]byte                // jsonEncode outputs, newline included
	var titles []string                  // parallel: feeds the bloom at finalize

	// Read back the previous generation's tail. The last successful sync
	// wrote search/L<Seq-1> in the common paths (this run's PutArticles
	// bumped Seq past it, or a previous run's sync failed without articles
	// since); after consecutive failed syncs the name is gone and the tail
	// rebuilds from data packs instead — heavier, still correct.
	if c.SearchTail > 0 {
		prevKey := genKey("search", c.Seq-1)
		if lines, count, err := o.readSearchLines(ctx, prevKey); err != nil {
			slog.Warn("search tail read-back failed, rebuilding tail", "key", prevKey, "error", err)
		} else if count != c.SearchTail {
			slog.Warn("search tail read-back mismatch, rebuilding tail",
				"key", prevKey, "entries", count, "srcht", c.SearchTail)
		} else {
			rawLines = lines
			titles = make([]string, len(lines))
			for i, line := range lines {
				var e SearchEntry
				if err := json.Unmarshal(line, &e); err != nil {
					return fmt.Errorf("parse %s line %d: %w", prevKey, i, err)
				}
				titles[i] = e.Title
			}
		}
	}

	if err := o.walkArticles(ctx, start+len(rawLines), c.TotalArticles, func(ad *ArticleData) error {
		if len(rawLines) == idxPackSize {
			if err := o.saveSearchShard(ctx, start/idxPackSize, rawLines, titles); err != nil {
				return err
			}
			rawLines, titles = rawLines[:0], titles[:0]
			start += idxPackSize
		}
		when := ad.Published
		if when == 0 {
			when = ad.FetchedAt
		}
		line, err := jsonEncode(&SearchEntry{ChannelID: ad.ChannelID, When: when, Title: ad.Title})
		if err != nil {
			return err
		}
		rawLines = append(rawLines, line)
		titles = append(titles, ad.Title)
		return nil
	}); err != nil {
		return err
	}

	latest := newPack()
	for _, line := range rawLines {
		if _, err := latest.Write(line); err != nil {
			return err
		}
	}
	if err := o.savePack(ctx, genKey("search", c.Seq), latest); err != nil {
		return err
	}

	if c.SearchPacks != nf {
		sum := newPack()
		for k := range nf {
			hdr, err := o.readPackHeader(ctx, finalizedSearchKey(k), searchBloomBytes)
			if err != nil {
				return err
			}
			if _, err := sum.Write(hdr); err != nil {
				return err
			}
		}
		if err := o.savePack(ctx, searchSummaryKey(nf), sum); err != nil {
			return err
		}
	}

	c.SearchPacks, c.SearchTail = nf, len(rawLines)
	return nil
}

// readSearchLines fetches a search shard and splits it into JSONL lines
// (terminators kept, so they re-emit verbatim). Missing key is an error —
// callers decide whether that warrants a rebuild or a failure.
func (o *DB) readSearchLines(ctx context.Context, key string) (lines [][]byte, count int, err error) {
	raw, err := o.readGz(ctx, key)
	if err != nil {
		return nil, 0, err
	}
	split := bytes.SplitAfter(raw, []byte("\n"))
	for _, line := range split {
		if len(line) > 0 {
			lines = append(lines, line)
		}
	}
	return lines, len(lines), nil
}

// saveSearchShard writes finalized shard n: the bloom over every gram of
// every folded title, then the JSONL lines.
func (o *DB) saveSearchShard(ctx context.Context, n int, rawLines [][]byte, titles []string) error {
	bloom := make([]byte, searchBloomBytes)
	for _, t := range titles {
		eachSearchGram(foldSearchText(t), func(gram string) { bloomAdd(bloom, gram) })
	}
	p := newPack()
	if _, err := p.Write(bloom); err != nil {
		return err
	}
	for _, line := range rawLines {
		if _, err := p.Write(line); err != nil {
			return err
		}
	}
	return o.savePack(ctx, finalizedSearchKey(n), p)
}

// GCSearchSummaries deletes superseded search bloom summaries
// (search/s<g>.gz) with the same grace window and stranded-name caveat as
// GCSummaries.
func (o *DB) GCSearchSummaries(ctx context.Context, keep int) error {
	return o.gcSweep(ctx, o.core.SearchPacks-keep-1, "search summary", func(g int) []string {
		return []string{searchSummaryKey(g)}
	})
}
