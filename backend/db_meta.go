package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// The meta/ pack series: derived {f,w,t} projection at 5k stride, consumed by
// the list (data.ts loadMeta) and search (search.ts). Finalized shard n
// (meta/<n>.gz) covers chron [n*metaPackSize, (n+1)*metaPackSize) as
// gzip(bloom[searchBloomBytes] ‖ JSONL of MetaEntry); the latest shard
// (meta/L<Seq>.gz) holds the tail with no bloom (readers always scan it);
// meta/s<N>.gz concatenates the N finalized blooms so the reader fetches only
// shards that can match a query. Design: docs/search-design.md. All writing
// happens here, post-hoc to PutArticles (SyncMeta); the frontend readers are
// frontend/src/js/data.ts (list) and frontend/src/js/search.ts (search).

// MetaEntry is the JSONL line of meta/*.gz shards. Line position within the
// shard is the chron offset — no chron is stored.
type MetaEntry struct {
	FeedID int `json:"f"`
	// When is the display timestamp: published, falling back to fetched_at
	// when unparsed — the same fallback the reader's row rendering wants, so
	// it is precomputed here.
	When  int64  `json:"w"`
	Title string `json:"t,omitempty"`
}

// finalizedMetaKey resolves the key of finalized meta shard n.
func finalizedMetaKey(n int) string {
	return fmt.Sprintf("meta/%d.gz", n)
}

// metaSummaryKey resolves the meta bloom-summary key covering n
// finalized shards.
func metaSummaryKey(n int) string {
	return fmt.Sprintf("meta/s%d.gz", n)
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
// FNV-1a is inlined: hash/fnv allocates a hasher per call, and this runs per
// gram across whole shards (finalize, validate, migration sweeps).
func bloomBits(gram string) [searchBloomK]uint32 {
	const offset64, prime64 = 14695981039346656037, 1099511628211
	sum := uint64(offset64)
	for i := 0; i < len(gram); i++ {
		sum ^= uint64(gram[i])
		sum *= prime64
	}
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
	slots := feedSlots(c)
	var data []ArticleData
	dataPackID := -1
	for from < to {
		p := from / idxPackSize
		key, size := idxKeyAndSize(c, p)
		buf, err := o.readGz(ctx, key)
		if err != nil {
			return err
		}
		pack, err := parseIdxPack(buf, p, size, slots)
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

// numFinalizedMeta is the number of finalized meta shards for an article count;
// mirrors numFinalizedIdx at the metaPackSize stride and the frontend's
// numFinalizedMeta (data.ts).
func numFinalizedMeta(totalArticles int) int {
	if totalArticles == 0 {
		return 0
	}
	return (totalArticles - 1) / metaPackSize
}

// SyncMeta reconciles the meta/ series with the store whenever db.gz's
// MetaPacks/MetaTail coverage lags TotalArticles: a normal append, a
// pre-meta store's first run after upgrade, a post-`srr gen --bump` reset,
// or a retry after a failed sync — one self-healing code path for all of
// them (the SyncIdxSummary philosophy). It extends the previous run's tail
// (meta/L<Seq-1>, trusted only when its entry count matches MetaTail)
// with the missing chron range, finalizing bloom-headed shards at each
// metaPackSize boundary, then writes the new latest shard and, when shards
// were finalized, rebuilds the bloom summary from cheap streaming header
// reads. The missing range is normally exactly `written` — the slice
// PutArticles just returned — so the common cycle builds entries from
// memory; any other gap (first run, post-bump, failed-sync catch-up) is read
// back from the idx+data packs. The coverage fields are set only after every
// save succeeds and the caller's Commit publishes them — so, like
// Seq/HdrPacks, no reader can learn a name before its content is durable.
// SyncMeta feeds BOTH the list (data.ts loadMeta) and search (search.ts).
func (o *DB) SyncMeta(ctx context.Context, written []ArticleData) error {
	c := &o.core
	if c.TotalArticles == 0 {
		return nil
	}
	nf := numFinalizedMeta(c.TotalArticles)
	if c.MetaPacks == nf && c.MetaPacks*metaPackSize+c.MetaTail == c.TotalArticles {
		return nil
	}
	if c.MetaPacks < 0 || c.MetaPacks > nf || c.MetaTail < 0 || c.MetaTail > metaPackSize ||
		c.MetaPacks*metaPackSize+c.MetaTail > c.TotalArticles {
		slog.Warn("inconsistent meta coverage, rebuilding from scratch",
			"mp", c.MetaPacks, "mt", c.MetaTail, "total_art", c.TotalArticles)
		c.MetaPacks, c.MetaTail = 0, 0
	}

	start := c.MetaPacks * metaPackSize // chron of the tail's first entry
	var rawLines [][]byte               // jsonEncode outputs, newline included

	// Read back the previous generation's tail. The last successful sync
	// wrote meta/L<Seq-1> in the common paths (this run's PutArticles
	// bumped Seq past it, or a previous run's sync failed without articles
	// since); after consecutive failed syncs the name is gone and the tail
	// rebuilds from data packs instead — heavier, still correct.
	if c.MetaTail > 0 {
		prevKey := genKey("meta", c.Seq-1)
		if lines, err := o.readMetaLines(ctx, prevKey); err != nil {
			slog.Warn("meta tail read-back failed, rebuilding tail", "key", prevKey, "error", err)
		} else if len(lines) != c.MetaTail {
			slog.Warn("meta tail read-back mismatch, rebuilding tail",
				"key", prevKey, "entries", len(lines), "mt", c.MetaTail)
		} else {
			rawLines = lines
		}
	}

	add := func(ad *ArticleData) error {
		if len(rawLines) == metaPackSize {
			if err := o.saveMetaShard(ctx, start/metaPackSize, rawLines); err != nil {
				return err
			}
			rawLines = rawLines[:0]
			start += metaPackSize
		}
		when := ad.Published
		if when == 0 {
			when = ad.FetchedAt
		}
		line, err := jsonEncode(&MetaEntry{FeedID: ad.FeedID, When: when, Title: ad.Title})
		if err != nil {
			return err
		}
		rawLines = append(rawLines, line)
		return nil
	}

	if from := start + len(rawLines); from+len(written) == c.TotalArticles {
		// The missing range is exactly this run's batch: written is what
		// PutArticles reported persisting, so the entries derive from the
		// very values the packs hold and no pack is re-read seconds after
		// it was written.
		for i := range written {
			if err := add(&written[i]); err != nil {
				return err
			}
		}
	} else if err := o.walkArticles(ctx, from, c.TotalArticles, add); err != nil {
		return err
	}

	latest := newPack()
	for _, line := range rawLines {
		if _, err := latest.Write(line); err != nil {
			return err
		}
	}
	if err := o.savePack(ctx, genKey("meta", c.Seq), latest); err != nil {
		return err
	}

	if c.MetaPacks != nf {
		if err := o.saveSummary(ctx, nf, func(k int) ([]byte, error) {
			return o.readPackHeader(ctx, finalizedMetaKey(k), searchBloomBytes)
		}, metaSummaryKey(nf)); err != nil {
			return err
		}
	}

	c.MetaPacks, c.MetaTail = nf, len(rawLines)
	return nil
}

// parseMetaEntries decodes a shard's JSONL body (bloom already stripped)
// into MetaEntry values. The wire format's one owner is this file's
// MetaEntry struct: writers jsonEncode it and every decode (here and
// saveMetaShard's bloom pass) unmarshals through it. Used by `srr
// inspect`'s checkMeta and the tests.
func parseMetaEntries(buf []byte) ([]MetaEntry, error) {
	var out []MetaEntry
	for i, line := range bytes.Split(buf, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var e MetaEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, fmt.Errorf("line %d: %w", i, err)
		}
		out = append(out, e)
	}
	return out, nil
}

// readMetaLines fetches a meta shard and splits it into JSONL lines
// (terminators kept, so they re-emit verbatim). Missing key is an error —
// callers decide whether that warrants a rebuild or a failure.
func (o *DB) readMetaLines(ctx context.Context, key string) ([][]byte, error) {
	raw, err := o.readGz(ctx, key)
	if err != nil {
		return nil, err
	}
	var lines [][]byte
	for _, line := range bytes.SplitAfter(raw, []byte("\n")) {
		if len(line) > 0 {
			lines = append(lines, line)
		}
	}
	return lines, nil
}

// saveMetaShard writes finalized shard n: the bloom over every gram of
// every folded title, then the JSONL lines. Titles are decoded here, once
// per finalized shard, so the sync loop never carries a parallel array.
func (o *DB) saveMetaShard(ctx context.Context, n int, rawLines [][]byte) error {
	bloom := make([]byte, searchBloomBytes)
	for i, line := range rawLines {
		var e MetaEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return fmt.Errorf("shard %d line %d: %w", n, i, err)
		}
		eachSearchGram(foldSearchText(e.Title), func(gram string) { bloomAdd(bloom, gram) })
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
	return o.savePackFinal(ctx, finalizedMetaKey(n), p)
}

// GCMetaSummaries deletes superseded meta bloom summaries
// (meta/s<g>.gz) with the same grace window and stranded-name caveat as
// GCSummaries.
func (o *DB) GCMetaSummaries(ctx context.Context, keep int) error {
	return o.gcSweep(ctx, o.core.MetaPacks-keep-1, "meta summary", func(g int) []string {
		return []string{metaSummaryKey(g)}
	})
}
