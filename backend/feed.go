package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	"srrb/ingest"
	"srrb/mod"
)

type Feed struct {
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	// Watermark is the max published unix-second ever seen across fetches.
	Watermark int64 `json:"wm,omitempty"`
	// BoundaryGUIDs is the GUIDs from the most recent non-empty fetch whose
	// pub equals Watermark (the dated boundary) or equals 0 (dateless).
	// Repopulated each non-empty fetch from the current response so its size
	// stays bounded by what the publisher currently exposes; a 200 OK with
	// zero items leaves the field untouched so a transient empty channel
	// doesn't drop dedup state.
	BoundaryGUIDs []uint32 `json:"bg,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
}

// fetch routes the feed through the selected FetchFunc so the
// dedup / watermark / pipeline path stays uniform across the built-in
// (#rss) and external ingest strategies. ingestName is resolved once per channel
// by Channel.Fetch and shared across all feeds in the channel.
func (feed *Feed) fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, engine *ingest.Fetcher, ch *Channel, fetchedAt int64, pipeline []string, ingestName string) ([]*Item, error) {
	slog.Debug("downloading feed", "url", feed.URL, "channel", ch)

	result, err := engine.Fetch(ctx, ingestName, client, buf, ingest.Request{
		URL:          feed.URL,
		ETag:         feed.ETag,
		LastModified: feed.LastModified,
		MaxSize:      cap(buf) - 1,
	})
	if err != nil {
		return nil, fmt.Errorf("ingest %q: %w", ingestName, err)
	}

	if result.NotModified {
		return nil, nil
	}

	// A 200 OK with zero items (e.g. transient empty channel) advances
	// the HTTP cache headers but leaves Watermark/BoundaryGUIDs untouched,
	// so prior items still dedup when the feed recovers.
	if len(result.Items) == 0 {
		feed.ETag = result.ETag
		feed.LastModified = result.LastModified
		return nil, nil
	}

	// Back-dated items below Watermark are not recovered (single-cursor
	// limitation), and watermark-second or dateless items that disappear
	// from the feed and reappear are re-ingested as duplicates (snapshot
	// semantics over carry-over).
	priorWatermark := feed.Watermark
	priorBoundary := uint32Set(feed.BoundaryGUIDs)

	maxPub := priorWatermark
	boundary := make(map[uint32]int64)

	var items []*Item
	for _, i := range result.Items {
		// Skip subsequent occurrences of the same GUID first so a within-fetch
		// duplicate cannot pollute boundary or maxPub with a stale pub.
		if _, dup := boundary[i.GUID]; dup {
			continue
		}

		var pubUnix int64
		if i.Published != nil {
			if u := i.Published.Unix(); u > 0 {
				// Clamp future-dated items so a publisher CMS bug
				// (year-2099 default) can't push Watermark past now and
				// silently swallow every subsequent real item.
				pubUnix = min(u, fetchedAt)
			}
		}

		boundary[i.GUID] = pubUnix

		if _, prev := priorBoundary[i.GUID]; prev {
			// A GUID we have already seen: keep deduping it, but do NOT let a
			// publisher re-dating an existing post raise Watermark. Otherwise a
			// genuinely-new article later dated between the old and the bumped
			// value is permanently and silently dropped by the watermark check.
			continue
		}
		// Only newly-seen items advance the watermark.
		if pubUnix > maxPub {
			maxPub = pubUnix
		}
		if pubUnix != 0 && pubUnix < priorWatermark {
			continue
		}

		if err := processItem(ctx, processor, pipeline, i); err != nil {
			// One bad item must not discard the whole feed's batch. Config
			// errors (unknown pipe token / bad params) are caught up front by
			// Module.Validate in Channel.Fetch, so an error here is a per-item
			// runtime failure: skip just this item. It stays recorded in
			// boundary, so it is not retried next fetch.
			slog.Warn("dropping item: pipeline error", "url", feed.URL, "link", i.Link, "err", err)
			continue
		}
		items = append(items, &Item{
			Channel:   ch,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: pubUnix,
		})
	}

	feed.Watermark = maxPub
	bg := make([]uint32, 0, len(boundary))
	for g, p := range boundary {
		// Keep dateless GUIDs and everything at or above the watermark so they
		// dedup next fetch. ">= maxPub" (not "==") also retains a re-dated
		// existing item whose bumped pub exceeds the (deliberately unraised)
		// watermark, so it stays deduped instead of re-ingesting.
		if p == 0 || p >= maxPub {
			bg = append(bg, g)
		}
	}
	slices.Sort(bg)
	feed.BoundaryGUIDs = bg
	feed.ETag = result.ETag
	feed.LastModified = result.LastModified
	return items, nil
}

func uint32Set(s []uint32) map[uint32]struct{} {
	m := make(map[uint32]struct{}, len(s))
	for _, v := range s {
		m[v] = struct{}{}
	}
	return m
}
