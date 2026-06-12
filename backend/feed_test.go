package main

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"srrb/ingest"
	"srrb/mod"
)

// The "test-stub" ingest strategy returns a fixed result for every URL —
// used to confirm Source.fetch dispatches through the ingest registry
// rather than hard-coding the RSS path.
func init() {
	// Registered once at init; safe because tests use distinct names.
	ingest.Register("test-stub", func(ingest.Deps) (ingest.FetchFunc, io.Closer) {
		pub := time.Unix(1700000000, 0)
		items := []*mod.RawItem{
			{GUID: 1, Title: "stub-1", Link: "https://stub/1", Published: &pub},
			{GUID: 2, Title: "stub-2", Link: "https://stub/2", Published: &pub},
		}
		return func(_ context.Context, _ *http.Client, _ []byte, _ ingest.Request) (ingest.Result, error) {
			return ingest.Result{Items: items}, nil
		}, nil
	})
}

func dispatchOnce(t *testing.T, feed *Feed, ch *Channel, rootIngest string) []*Item {
	t.Helper()
	buf := make([]byte, 1<<20)
	const fetchedAt int64 = 4_102_444_800
	ingestName := ingest.Select(ch.Ingest, rootIngest)
	run := &fetchRun{engine: ingest.New(ingest.Deps{}), fetchedAt: fetchedAt}
	items, err := feed.fetch(context.Background(), run, buf, mod.New(nil), ch, ch.Pipe, ingestName)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return items
}

// Channel-level ingest strategy is inherited by all feeds.
func TestFeedFetchInheritsFromChannel(t *testing.T) {
	feed := &Feed{URL: "irrelevant://value"}
	ch := &Channel{Title: "T", Ingest: "#test-stub", Feeds: []*Feed{feed}}
	items := dispatchOnce(t, feed, ch, "")
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (channel-level ingest inherited)", len(items))
	}
}

// The db.gz root Ingest applies when the channel has no override.
func TestFeedFetchUsesRootIngest(t *testing.T) {
	feed := &Feed{URL: "irrelevant://value"}
	ch := &Channel{Title: "T", Feeds: []*Feed{feed}}
	items := dispatchOnce(t, feed, ch, "#test-stub")
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2 (root ingest applied)", len(items))
	}
}
