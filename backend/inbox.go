package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"

	"srr/store"
)

// The inbox/spool pattern splits fetch EGRESS from the single writer: any box
// may fetch feeds and spool one cycle's result as a write-once object; exactly
// one box still holds the lock and writes packs. See docs/INBOX-SPEC.md — read
// it before touching this file, DBCore.Inbox, or the drain step in runFetch.

// inboxKey is a producer's single spool slot. Fixed per producer name (not
// generation-named): the slot's existence IS the backpressure signal, so a
// producer whose previous cycle has not been drained skips rather than piling
// up a queue the consolidator would have to reorder.
func inboxKey(name string) string { return "inbox/" + name + ".gz" }

// maxInboxSize bounds a spool object the consolidator will parse. A producer is
// a trusted peer, but it is still a remote process writing into our store; an
// unbounded read would let a runaway producer exhaust the writer's memory.
const maxInboxSize = 256 << 20

// inboxEnvelope is one producer cycle on the wire.
type inboxEnvelope struct {
	Producer string      `json:"producer"`
	CycleID  int64       `json:"cycle_id"`
	Feeds    []inboxFeed `json:"feeds"`
}

// inboxFeed is one feed's spooled result. URL rides alongside ID so the
// consolidator can detect a feed repointed or recreated since the producer's
// read-only snapshot and discard the record instead of applying it to a feed it
// no longer describes.
type inboxFeed struct {
	ID    int         `json:"id"`
	URL   string      `json:"url"`
	State inboxState  `json:"state"`
	Items []inboxItem `json:"items,omitempty"`
	// Stamps are the persistent-dedup pool hashes this feed collected during the
	// producer's fan-out (Feed.seenStamps). Carrying them lets the consolidator
	// feed its own pool, so a spooled feed dedups like a locally-fetched one.
	Stamps []uint32 `json:"stamps,omitempty"`
}

// inboxState is the per-feed fetch state a cycle produces. It is exactly the
// set Feed.Fetch mutates and the writer persists (across db.gz and the seen
// sidecar) — the producer computed it, so the consolidator adopts it wholesale.
type inboxState struct {
	Watermark     int64    `json:"wm,omitempty"`
	BoundaryGUIDs []uint32 `json:"bg,omitempty"`
	ETag          string   `json:"etag,omitempty"`
	LastModified  string   `json:"last_modified,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
	LastOK        int64    `json:"last_ok,omitempty"`
	FailStreak    int      `json:"fail_streak,omitempty"`
	LastNew       int64    `json:"last_new,omitempty"`
}

// inboxItem is one article on the wire. Deliberately the *item* fields, NOT a
// pre-encoded data-pack line: ArticleData.FetchedAt must be stamped by the
// CONSOLIDATOR's cycle, not the producer's, or a batch mixing the two loses the
// chron-monotone fetched_at that ExpireArticles' contiguous-prefix model and
// `srr art ls --since/--until`'s binary search both depend on. Published — the
// timestamp a reader sees — is the producer's and rides through verbatim.
type inboxItem struct {
	Title     string `json:"t,omitempty"`
	Link      string `json:"l,omitempty"`
	Content   string `json:"c,omitempty"`
	Published int64  `json:"p,omitempty"`
	Lang      string `json:"g,omitempty"`
}

// spoolEnvelope builds the envelope for the feeds this producer cycle fetched.
func spoolEnvelope(name string, cycleID int64, feeds []*Feed) inboxEnvelope {
	env := inboxEnvelope{Producer: name, CycleID: cycleID}
	for _, ch := range feeds {
		rec := inboxFeed{
			ID:  ch.id,
			URL: ch.URL,
			State: inboxState{
				Watermark:     ch.Watermark,
				BoundaryGUIDs: ch.BoundaryGUIDs,
				ETag:          ch.ETag,
				LastModified:  ch.LastModified,
				FetchError:    ch.FetchError,
				LastOK:        ch.LastOK,
				FailStreak:    ch.FailStreak,
				LastNew:       ch.LastNew,
			},
			Stamps: ch.seenStamps,
		}
		for _, it := range ch.newItems {
			rec.Items = append(rec.Items, inboxItem{
				Title:     it.Title,
				Link:      it.Link,
				Content:   it.Content,
				Published: it.Published,
				Lang:      it.Lang,
			})
		}
		env.Feeds = append(env.Feeds, rec)
	}
	return env
}

// writeInbox publishes one producer cycle to its slot. AtomicPut, so a
// consolidator draining concurrently never observes a half-written envelope.
func writeInbox(ctx context.Context, be store.Backend, name string, env inboxEnvelope) error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(env); err != nil {
		return fmt.Errorf("encode inbox envelope: %w", err)
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("compress inbox envelope: %w", err)
	}
	key := inboxKey(name)
	if err := be.AtomicPut(ctx, key, &buf, store.ObjectMeta{}); err != nil {
		return fmt.Errorf("write %s: %w", key, err)
	}
	return nil
}

// readInbox loads a producer's slot. A missing slot is (nil, nil) — the normal
// state between spools.
func readInbox(ctx context.Context, be store.Backend, name string) (*inboxEnvelope, error) {
	key := inboxKey(name)
	rc, err := be.Get(ctx, key, true)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	if rc == nil {
		return nil, nil
	}
	defer rc.Close()

	zr, err := gzip.NewReader(io.LimitReader(rc, maxInboxSize))
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	defer zr.Close()

	var env inboxEnvelope
	if err := json.NewDecoder(io.LimitReader(zr, maxInboxSize)).Decode(&env); err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	return &env, nil
}

// drainInbox folds every configured producer's pending spool into this cycle.
// It returns the extra articles to append to the batch and the producer names
// whose slots should be removed after a successful Commit.
//
// Failures are per-producer and warn-only: a spool that cannot be read or
// parsed must never fail the consolidator's own cycle, and the slot is left in
// place so the next cycle retries it.
func (db *DB) drainInbox(ctx context.Context, producers []string, today uint16) ([]*Item, []string) {
	var articles []*Item
	var drained []string

	for _, name := range producers {
		if name == "" {
			continue
		}
		env, err := readInbox(ctx, db.Backend, name)
		if err != nil {
			slog.Warn("drain inbox", "producer", name, "error", err)
			continue
		}
		if env == nil {
			continue
		}
		// Already applied (a crash between Commit and Rm): skip the content but
		// still reap the slot, which is the retry this branch exists for.
		if env.CycleID <= db.core.Inbox[name] {
			slog.Debug("inbox slot already drained", "producer", name, "cycle_id", env.CycleID)
			drained = append(drained, name)
			continue
		}

		items, feeds := db.applyInbox(env, today)
		articles = append(articles, items...)
		if db.core.Inbox == nil {
			db.core.Inbox = map[string]int64{}
		}
		db.core.Inbox[name] = env.CycleID
		drained = append(drained, name)
		slog.Info("drained inbox", "producer", name, "cycle_id", env.CycleID,
			"feeds", feeds, "articles", len(items))
	}
	return articles, drained
}

// applyInbox folds one envelope into the live DB: per-feed state onto the
// authoritative feed, dedup stamps into the pool, and the articles returned for
// the caller's batch. Returns the articles and how many feed records applied.
func (db *DB) applyInbox(env *inboxEnvelope, today uint16) ([]*Item, int) {
	var articles []*Item
	applied := 0

	for _, rec := range env.Feeds {
		ch, ok := db.core.Feeds[rec.ID]
		if !ok {
			slog.Warn("inbox record names an unknown feed; discarded",
				"producer", env.Producer, "feed_id", rec.ID, "url", rec.URL)
			continue
		}
		// The operator repointed or recreated this feed since the producer's
		// read-only snapshot: its dedup state and articles describe a different
		// source. Discard rather than apply them to the wrong feed.
		if ch.URL != rec.URL {
			slog.Warn("inbox record URL no longer matches the feed; discarded",
				"producer", env.Producer, "feed_id", rec.ID,
				"spooled_url", rec.URL, "feed_url", ch.URL)
			continue
		}

		ch.Watermark = rec.State.Watermark
		ch.BoundaryGUIDs = rec.State.BoundaryGUIDs
		ch.ETag = rec.State.ETag
		ch.LastModified = rec.State.LastModified
		ch.FetchError = rec.State.FetchError
		ch.LastOK = rec.State.LastOK
		ch.FailStreak = rec.State.FailStreak
		ch.LastNew = rec.State.LastNew

		for _, h := range rec.Stamps {
			db.seen.stamp(ch.id, h, today)
		}
		for _, it := range rec.Items {
			articles = append(articles, &Item{
				Feed:      ch,
				Title:     it.Title,
				Link:      it.Link,
				Content:   it.Content,
				Published: it.Published,
				Lang:      it.Lang,
			})
		}
		applied++
	}
	return articles, applied
}

// reapInbox removes the slots drained this cycle. Warn-only and run AFTER
// Commit: the drained watermark is already durable, so a slot that survives is
// skipped (not re-applied) next cycle and reaped then.
func reapInbox(ctx context.Context, be store.Backend, names []string) {
	for _, name := range names {
		if err := be.Rm(ctx, inboxKey(name)); err != nil {
			slog.Warn("reap inbox slot", "producer", name, "error", err)
		}
	}
}
