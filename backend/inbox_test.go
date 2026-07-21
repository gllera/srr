package main

import (
	"context"
	"strings"
	"testing"
)

// spoolTestFeed registers a feed and returns it, so tests exercise the real
// AddFeed id assignment rather than fabricating a map entry.
func spoolTestFeed(t *testing.T, db *DB, url string) *Feed {
	t.Helper()
	ch := &Feed{Title: "T", URL: url}
	if err := db.AddFeed(ch); err != nil {
		t.Fatalf("AddFeed: %v", err)
	}
	return ch
}

// A spool object round-trips: what the producer wrote is exactly what the
// consolidator parses.
func TestInboxEnvelopeRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := spoolTestFeed(t, db, "https://example.test/feed")
	ch.Watermark = 1700000000
	ch.BoundaryGUIDs = []uint32{7, 8, 9}
	ch.ETag = `"tag"`
	ch.FailStreak = 3
	ch.seenStamps = []uint32{7, 8}
	ch.newItems = []*Item{{Feed: ch, Title: "Hello", Link: "https://example.test/1", Content: "<p>hi</p>", Published: 1699999999, Lang: "en"}}

	if err := writeInbox(ctx, db.Backend, "producerA", spoolEnvelope("producerA", 1700000000, []*Feed{ch})); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}

	got, err := readInbox(ctx, db.Backend, "producerA")
	if err != nil {
		t.Fatalf("readInbox: %v", err)
	}
	if got == nil {
		t.Fatal("readInbox returned nil for a slot that was just written")
	}
	if got.Producer != "producerA" || got.CycleID != 1700000000 || len(got.Feeds) != 1 {
		t.Fatalf("envelope = %+v, want producerA/1700000000 with 1 feed", got)
	}
	rec := got.Feeds[0]
	if rec.ID != ch.id || rec.URL != ch.URL {
		t.Errorf("feed identity = (%d, %q), want (%d, %q)", rec.ID, rec.URL, ch.id, ch.URL)
	}
	if rec.State.Watermark != 1700000000 || rec.State.ETag != `"tag"` || rec.State.FailStreak != 3 {
		t.Errorf("state = %+v, want the producer's fetch state verbatim", rec.State)
	}
	if len(rec.State.BoundaryGUIDs) != 3 || len(rec.Stamps) != 2 {
		t.Errorf("bg=%v stamps=%v, want 3 and 2", rec.State.BoundaryGUIDs, rec.Stamps)
	}
	if len(rec.Items) != 1 || rec.Items[0].Title != "Hello" || rec.Items[0].Published != 1699999999 {
		t.Errorf("items = %+v, want the one item with its own published time", rec.Items)
	}
}

// A missing slot is the normal state between spools, not an error.
func TestReadInboxMissingSlotIsNil(t *testing.T) {
	db, _, _ := setupTestDB(t)
	env, err := readInbox(ctx, db.Backend, "nobody")
	if err != nil {
		t.Fatalf("readInbox on a missing slot: %v", err)
	}
	if env != nil {
		t.Errorf("env = %+v, want nil", env)
	}
}

// Draining applies the spooled state and articles once. Draining the SAME
// object again must ingest nothing — the crash-after-Commit-before-Rm case,
// where the slot survives but the watermark already advanced.
func TestDrainInboxIsIdempotent(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := spoolTestFeed(t, db, "https://example.test/feed")
	producer := &Feed{id: ch.id, URL: ch.URL, Watermark: 42, BoundaryGUIDs: []uint32{5}, LastOK: 99}
	producer.seenStamps = []uint32{5}
	producer.newItems = []*Item{{Title: "A", Content: "a"}, {Title: "B", Content: "b"}}

	if err := writeInbox(ctx, db.Backend, "p1", spoolEnvelope("p1", 1000, []*Feed{producer})); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}

	arts, slots := db.drainInbox(ctx, []string{"p1"}, 100)
	if len(arts) != 2 {
		t.Fatalf("drained %d articles, want 2", len(arts))
	}
	if arts[0].Feed != ch {
		t.Error("drained article is not attached to the authoritative feed")
	}
	if ch.Watermark != 42 || len(ch.BoundaryGUIDs) != 1 || ch.LastOK != 99 {
		t.Errorf("feed state = wm %d bg %v last_ok %d, want the spooled values", ch.Watermark, ch.BoundaryGUIDs, ch.LastOK)
	}
	if db.core.Inbox["p1"] != 1000 {
		t.Errorf("Inbox[p1] = %d, want the drained cycle_id 1000", db.core.Inbox["p1"])
	}
	if len(slots) != 1 || slots[0] != "p1" {
		t.Errorf("slots = %v, want [p1]", slots)
	}

	// Second drain of the same object: the watermark makes it a no-op, but the
	// slot is still reported so the missed Rm is retried.
	arts2, slots2 := db.drainInbox(ctx, []string{"p1"}, 100)
	if len(arts2) != 0 {
		t.Errorf("re-drained %d articles, want 0 (cycle_id already applied)", len(arts2))
	}
	if len(slots2) != 1 {
		t.Errorf("slots = %v, want the stale slot still reported for reaping", slots2)
	}
}

// The FET5-style stale-config guard: an operator who repointed the feed since
// the producer's read-only snapshot must not have that feed's dedup state and
// articles overwritten by a spool describing the OLD source.
func TestDrainInboxDiscardsURLMismatch(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := spoolTestFeed(t, db, "https://old.test/feed")
	producer := &Feed{id: ch.id, URL: "https://old.test/feed", Watermark: 42}
	producer.newItems = []*Item{{Title: "stale", Content: "x"}}
	if err := writeInbox(ctx, db.Backend, "p1", spoolEnvelope("p1", 1000, []*Feed{producer})); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}

	// The operator repoints the feed before the drain.
	ch.URL = "https://new.test/feed"

	arts, _ := db.drainInbox(ctx, []string{"p1"}, 100)
	if len(arts) != 0 {
		t.Errorf("ingested %d articles from a mismatched spool, want 0", len(arts))
	}
	if ch.Watermark != 0 {
		t.Errorf("Watermark = %d, want 0: the repointed feed must keep its own (reset) state", ch.Watermark)
	}
	// The envelope is still marked drained — retrying it would only re-discard.
	if db.core.Inbox["p1"] != 1000 {
		t.Errorf("Inbox[p1] = %d, want 1000", db.core.Inbox["p1"])
	}
}

// A record naming a feed that no longer exists is discarded, not a crash.
func TestDrainInboxDiscardsUnknownFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	producer := &Feed{id: 4242, URL: "https://gone.test/feed"}
	producer.newItems = []*Item{{Title: "orphan", Content: "x"}}
	if err := writeInbox(ctx, db.Backend, "p1", spoolEnvelope("p1", 1000, []*Feed{producer})); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}
	arts, _ := db.drainInbox(ctx, []string{"p1"}, 100)
	if len(arts) != 0 {
		t.Errorf("ingested %d articles for an unknown feed, want 0", len(arts))
	}
}

// An unreadable spool must not fail the consolidator's own cycle, and its slot
// must stay in place so the next cycle retries it.
func TestDrainInboxCorruptSlotIsWarnOnly(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := db.Put(ctx, inboxKey("p1"), strings.NewReader("not gzip"), true); err != nil {
		t.Fatalf("seed: %v", err)
	}
	arts, slots := db.drainInbox(ctx, []string{"p1"}, 100)
	if len(arts) != 0 || len(slots) != 0 {
		t.Errorf("arts=%d slots=%v, want nothing drained and the slot left alone", len(arts), slots)
	}
}

// reapInbox removes exactly the drained slots.
func TestReapInboxRemovesSlots(t *testing.T) {
	db, _, _ := setupTestDB(t)
	if err := writeInbox(ctx, db.Backend, "p1", inboxEnvelope{Producer: "p1", CycleID: 1}); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}
	reapInbox(context.Background(), db.Backend, []string{"p1"})
	size, err := db.Stat(ctx, inboxKey("p1"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if size != 0 {
		t.Errorf("slot still %d bytes after reap", size)
	}
}

// A producer partition must be deliberate, and its name must stay inside one
// store key segment.
func TestSpoolSlotValidation(t *testing.T) {
	if _, err := (&FetchCmd{Spool: true}).spoolSlot(); err == nil {
		t.Error("--spool with no selector was accepted; want a hard error")
	}
	o := &FetchCmd{Spool: true, SpoolName: "bastion"}
	o.Tag = []string{"x"}
	name, err := o.spoolSlot()
	if err != nil || name != "bastion" {
		t.Errorf("spoolSlot = (%q, %v), want (bastion, nil)", name, err)
	}
	// An empty name is NOT in this list: it is the documented "use the
	// hostname" default, covered below.
	for _, bad := range []string{"../db", "a/b", ".", "..", "na me"} {
		o := &FetchCmd{Spool: true, SpoolName: bad}
		o.Feed = []int{1}
		if _, err := o.spoolSlot(); err == nil {
			t.Errorf("spool name %q accepted, want rejection", bad)
		}
	}
	// With no explicit name it falls back to the hostname, which must validate.
	o2 := &FetchCmd{Spool: true}
	o2.Feed = []int{1}
	if _, err := o2.spoolSlot(); err != nil {
		t.Errorf("hostname default rejected: %v", err)
	}
}

// The end-to-end shape: a spooled cycle drained into the writer produces a
// store that passes the full consistency sweep, with the drained articles
// carrying the CONSOLIDATOR's fetched_at (the chron-monotone invariant the
// expiration walk and `art ls --since` binary search both rely on) while
// keeping the producer's published times.
func TestDrainedCycleValidates(t *testing.T) {
	db, _, _ := setupTestDB(t)
	ch := spoolTestFeed(t, db, "https://example.test/feed")

	producer := &Feed{id: ch.id, URL: ch.URL, Watermark: 1699999999}
	producer.newItems = []*Item{
		{Title: "older", Content: "a", Published: 1699999000},
		{Title: "newer", Content: "b", Published: 1699999999},
	}
	if err := writeInbox(ctx, db.Backend, "p1", spoolEnvelope("p1", 1000, []*Feed{producer})); err != nil {
		t.Fatalf("writeInbox: %v", err)
	}

	// The consolidator's own cycle clock, distinct from the producer's.
	db.core.FetchedAt = 1700000500
	arts, slots := db.drainInbox(ctx, []string{"p1"}, uint16(db.core.FetchedAt/86400))
	if len(arts) != 2 {
		t.Fatalf("drained %d articles, want 2", len(arts))
	}

	written, err := db.PutArticles(ctx, arts)
	if err != nil {
		t.Fatalf("PutArticles: %v", err)
	}
	for _, a := range written {
		if a.FetchedAt != db.core.FetchedAt {
			t.Errorf("FetchedAt = %d, want the consolidator's %d", a.FetchedAt, db.core.FetchedAt)
		}
	}
	if written[0].Published != 1699999000 || written[1].Published != 1699999999 {
		t.Errorf("published times = %d/%d, want the producer's preserved verbatim",
			written[0].Published, written[1].Published)
	}
	if err := db.SyncIdxSummary(ctx); err != nil {
		t.Fatalf("SyncIdxSummary: %v", err)
	}
	if err := db.SyncMeta(ctx, written); err != nil {
		t.Fatalf("SyncMeta: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	reapInbox(ctx, db.Backend, slots)

	if err := (&InspectCmd{Chron: -1, Validate: true}).Run(); err != nil {
		t.Fatalf("inspect --validate after a drained cycle: %v", err)
	}
}
