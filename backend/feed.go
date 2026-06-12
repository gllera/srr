package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
func (feed *Feed) fetch(ctx context.Context, run *fetchRun, buf []byte, processor *mod.Module, ch *Channel, pipeline []string, ingestName string) ([]*Item, error) {
	slog.Debug("downloading feed", "url", feed.URL, "channel", ch)

	// Every fetcher gets the run's shared cache dir as its working directory
	// (Request.AssetDir, always non-empty here — created in FetchCmd.fetch) and
	// may self-host files it leaves there: the post-pipeline upload step below
	// scans each item for "#"-markers naming a real file in the dir and uploads
	// them. Built-in or external, the fetcher owns the layout inside.
	result, err := run.engine.Fetch(ctx, ingestName, run.client, buf, ingest.Request{
		URL:          feed.URL,
		ETag:         feed.ETag,
		LastModified: feed.LastModified,
		MaxSize:      cap(buf) - 1,
		AssetDir:     run.cacheDir,
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
		// An external ingest strategy returns items as a JSON array; a null
		// element decodes to a nil *mod.RawItem. Skip it before any field access
		// — otherwise i.GUID below panics, and (with no recover in the worker)
		// crashes the whole fetch process, taking every feed down with it.
		if i == nil {
			continue
		}
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
				pubUnix = min(u, run.fetchedAt)
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
		// Store-side end-of-pipeline step, kept out of processItem (which stays a
		// pure, store-free transform): scan the item's self-hostable attributes
		// (img/video src/poster, a href — see mod.RewriteAttrs) for upload markers
		// and rewrite them to their final store keys. A marker is a value starting
		// with "#" whose remainder names a regular file the fetcher left in
		// run.cacheDir (e.g. "#/photo.jpg"); a "#..." naming no such file is an
		// ordinary in-page fragment (#section), left as-is.
		//
		// A failed upload (store error, or an UploadCacheRef guard tripping on
		// oversize/traversal) hard-fails the whole feed fetch rather than publish
		// an item still pointing at "#/..." for an asset that never reached the
		// store. Feed state (watermark, dedup, etag) is left untouched on the
		// error path, so a transient store failure self-heals next fetch; a
		// permanently-rejected asset (e.g. over SRR_MAX_MEDIA_SIZE) wedges the
		// feed until it is fixed.
		//
		// RewriteAttrs handles the marker convention: it skips content with no
		// marker-shaped attribute (the common case, as built-in #rss feeds never
		// emit markers) and hands fn the path with the "#" already stripped.
		i.Content, err = mod.RewriteAttrs(i.Content, func(local string) (string, bool, error) {
			key, err := run.assets.UploadCacheRef(ctx, run.cacheDir, local)
			switch {
			case err == nil:
				return key, true, nil
			case errors.Is(err, errNotAsset), errors.Is(err, errEscapesCache):
				// Not a real upload marker: a bare fragment (#section → "section")
				// names no file in the cache dir, and a value escaping the dir
				// (e.g. "#../secret", attacker-influenced content) must be declined
				// rather than wedge the feed permanently. Genuine in-cache upload
				// failures (oversize, store error) still fail the feed below.
				return "", false, nil
			default:
				return "", false, fmt.Errorf("self-host asset %q: %w", local, err)
			}
		})
		if err != nil {
			return nil, err
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
