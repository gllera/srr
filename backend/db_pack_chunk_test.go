package main

import (
	"bytes"
	"fmt"
	"testing"
)

// S69 — the --max-batch-bytes chunking of PutArticles. A batch is the one size
// in the writer that nothing bounds (an OPML backfill or a first fetch of a
// long archive hands the whole import over at once), so an oversized one is
// driven through materialization in capped sub-batches. The cap must be a
// MEMORY knob and nothing else: the store a chunked cycle publishes has to be
// byte-identical to the one the single-pass cycle publishes, which is what
// TestChunkedBatchEquivalence pins.

// assertStoreEquivalent compares two stores the way §12.1's consolidation
// equivalence does: the published state (deliberately NOT the name table —
// stems are opaque and monotone, so a store reached through more passes
// legitimately holds different stems for the same positions) plus the raw bytes
// of every object each core claims, keyed by POSITION.
func assertStoreEquivalent(t *testing.T, dirA string, coreA *DBCore, dirB string, coreB *DBCore) {
	t.Helper()
	state := func(c *DBCore) []byte {
		b, err := jsonEncode([]any{c.ManifestState, c.ManifestWriterState, c.Feeds})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	if jsonA, jsonB := state(coreA), state(coreB); !bytes.Equal(jsonA, jsonB) {
		t.Errorf("published state differs:\nA: %s\nB: %s", jsonA, jsonB)
	}

	fpA := storeFingerprint(t, dirA, coreA)
	fpB := storeFingerprint(t, dirB, coreB)
	if len(fpA) != len(fpB) {
		t.Errorf("published position sets differ: %d vs %d", len(fpA), len(fpB))
	}
	for label, a := range fpA {
		b, ok := fpB[label]
		if !ok {
			t.Errorf("%s: published by store A only", label)
			continue
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s: bytes differ (%d vs %d bytes)", label, len(a), len(b))
		}
	}
}

// TestChunkedBatchEquivalence is S69's gate, built on the
// TestConsolidationEquivalence pattern: the same batch script driven with a
// --max-batch-bytes cap small enough to split its big batch into dozens of
// passes must publish byte-identical packs, tails and summaries — and an equal
// published state — to the same script with chunking off. Run over BOTH
// materialization paths, since the split multiplies whichever one a pass takes:
// the MaxDeltas=0 kill switch (every pass consolidates the tail, so the tail
// packs are saved, re-read and extended dozens of times mid-batch) and the
// delta path (every pass publishes its own segment, so the chain the final
// consolidation replays is segmented differently).
//
// What it proves is precisely "chunking is byte-invisible": chron order, the
// idx entries and their as-of-chron header counts, the data-pack roll points,
// the boundary footers, the derived meta shards and both summaries all land on
// the same bytes at the same positions — and the state carries total_art,
// next_pid, pack_off, mt/na, the head projection, and every feed's TotalArt /
// ContentBytes / AddIdx. Object NAMES are excluded on purpose: a pass is what
// draws a stem, so more passes legitimately means different (never reused)
// stems, which is the one thing chunking is allowed to change.
func TestChunkedBatchEquivalence(t *testing.T) {
	// 64 KB against the script's ~400-byte JSONL lines: the 4900-article batch
	// splits into ~30 passes while every small batch stays single-pass.
	const capKB = 64

	for _, tc := range []struct {
		name      string
		maxDeltas int
	}{
		{"consolidate-every-pass", 0},
		{"delta-every-pass", 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dirPlain, corePlain, _ := driveDeltaStoreChunked(t, tc.maxDeltas, 0)
			dirChunked, coreChunked, _ := driveDeltaStoreChunked(t, tc.maxDeltas, capKB)

			// Not vacuous: a pass is what draws stems from the data series'
			// counter (a delta segment, or a consolidation's fresh tail), so a
			// genuinely split batch must have drawn strictly more of them.
			if a, b := coreChunked.Names.Next[dataSeries], corePlain.Names.Next[dataSeries]; a <= b {
				t.Fatalf("chunking never split a batch: %d data stems drawn chunked vs %d unchunked", a, b)
			}
			assertStoreEquivalent(t, dirPlain, corePlain, dirChunked, coreChunked)
		})
	}
}

// TestPutArticlesChunksAtTheCap pins the split arithmetic itself, on the delta
// path where one pass == one observable segment: the cap bounds a pass, it
// cannot split an article (an over-cap article forms a pass of its own), and
// 0 is a true kill switch — one pass for the whole batch, exactly the
// pre-chunking path. Accounting is per article either way.
func TestPutArticlesChunksAtTheCap(t *testing.T) {
	for _, tc := range []struct {
		name       string
		maxBatchKB int
		articles   int
		contentLen int
		// wantPasses is the number of delta segments the batch must publish;
		// lineLo/lineHi bracket the encoded JSONL line size that makes it right,
		// so a fixture drift fails as a fixture drift rather than as a bug.
		wantPasses     int
		lineLo, lineHi int
	}{
		// 4 KB cap, ~3.1 KB lines: two articles tip a pass over the cap.
		{"off is one pass", 0, 12, 3000, 1, 2049, 4096},
		{"cap splits the batch", 4, 12, 3000, 6, 2049, 4096},
		// A single article past the cap is its own pass — the cap is a bound on
		// a pass, not a way to split an article.
		{"an over-cap article is its own pass", 4, 3, 9000, 3, 4097, 16384},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, c, _ := setupTestDB(t)
			globals.MaxDeltas = 1000        // the chain cap must never be the trigger
			globals.MaxDeltaBytes = 1 << 20 // nor the byte cap (KB)
			globals.MaxBatchBytes = tc.maxBatchKB

			feed := &Feed{Title: "feed", URL: "https://example.com/f"}
			if err := db.AddFeed(feed); err != nil {
				t.Fatalf("AddFeed: %v", err)
			}
			c.FetchedAt = 1_700_000_000

			rng := lcg(7)
			batch := make([]*Item, 0, tc.articles)
			for i := range tc.articles {
				batch = append(batch, &Item{
					Feed:      feed,
					Title:     fmt.Sprintf("title %d", i),
					Content:   rng.content(tc.contentLen),
					Link:      fmt.Sprintf("https://example.com/a/%d", i),
					Published: 1_600_000_000 + int64(i)*60,
				})
			}

			// Bracket the fixture: the pass counts below are arithmetic on this
			// size, so pin it rather than let a format change quietly re-shape
			// the test into a tautology.
			probe := batch[0].articleData(c.FetchedAt)
			line, err := jsonEncode(&probe)
			if err != nil {
				t.Fatalf("jsonEncode: %v", err)
			}
			if len(line) < tc.lineLo || len(line) > tc.lineHi {
				t.Fatalf("fixture drift: encoded line is %d B, expected [%d, %d]", len(line), tc.lineLo, tc.lineHi)
			}

			written, err := db.PutArticles(ctx, batch)
			if err != nil {
				t.Fatalf("PutArticles: %v", err)
			}
			if len(written) != tc.articles {
				t.Fatalf("PutArticles returned %d articles, want %d", len(written), tc.articles)
			}
			if got := c.numDeltas(); got != tc.wantPasses {
				t.Errorf("published %d delta segment(s), want %d", got, tc.wantPasses)
			}
			// Accounting is per article and runs exactly once, whatever the
			// split: the counters must not notice the cap at all.
			if c.TotalArticles != tc.articles || c.DeltaArticles != tc.articles {
				t.Errorf("total_art=%d na=%d, want %d for both", c.TotalArticles, c.DeltaArticles, tc.articles)
			}
			if feed.TotalArt != tc.articles {
				t.Errorf("feed TotalArt=%d, want %d", feed.TotalArt, tc.articles)
			}
			var wantBytes int64
			for i := range written {
				l, err := jsonEncode(&written[i])
				if err != nil {
					t.Fatalf("jsonEncode: %v", err)
				}
				wantBytes += int64(len(l))
			}
			if feed.ContentBytes != wantBytes || c.DeltaBytes != wantBytes {
				t.Errorf("cb=%d dby=%d, want %d for both", feed.ContentBytes, c.DeltaBytes, wantBytes)
			}
			// The chron order the readers address by must survive the split.
			for i := range written {
				if want := batch[i].Link; written[i].Link != want {
					t.Fatalf("written[%d].Link = %q, want %q — chunking reordered the batch", i, written[i].Link, want)
				}
			}
		})
	}
}
