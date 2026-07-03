package main

import (
	"context"
	"net/http"
	"sort"
	"strings"
)

// overviewView is the whole-store snapshot the admin console renders every tab
// from in a single db.gz read. It is db.gz handed to the webui, with feeds
// projected to the UI list shape — exposing the map-key id and the friendly
// `error`, and omitting the per-feed dedup/cache internals (bg/etag/wm/
// last_modified) that the UI can't use and that would bloat the payload — plus
// the derived tag buckets riding along so the client needn't re-aggregate.
// Replaces the up-to-three separate store opens the Feeds/Tools tabs each did.
type overviewView struct {
	Feeds     []feedListView    `json:"feeds"`
	Tags      []tagCount        `json:"tags"`
	Recipes   map[string]Recipe `json:"recipes"`
	Out       []OutFeed         `json:"out"`
	Gen       int               `json:"gen"`
	FetchedAt int64             `json:"fetched_at"`
	TotalArt  int               `json:"total_art"`
	// CdnURL lets the syndicate tab link the produced out/<name> files;
	// omitted when SRR_CDN_URL is unset (syndication writes are skipped then).
	CdnURL string `json:"cdn_url,omitempty"`
}

func getOverview(w http.ResponseWriter, r *http.Request) {
	var out overviewView
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		// Project feeds to the UI list shape, sorted case-insensitively by title.
		feeds := make([]feedListView, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			feeds = append(feeds, listViewOf(ch))
		}
		sort.Slice(feeds, func(i, j int) bool {
			return strings.ToLower(feeds[i].Title) < strings.ToLower(feeds[j].Title)
		})
		// Aggregate feeds into tag buckets (tag "" = untagged), sorted by tag.
		agg := map[string]*tagCount{}
		for _, ch := range db.Feeds() {
			tc := agg[ch.Tag]
			if tc == nil {
				tc = &tagCount{Tag: ch.Tag}
				agg[ch.Tag] = tc
			}
			tc.Feeds++
			tc.Articles += ch.TotalArt
		}
		tags := make([]tagCount, 0, len(agg))
		for _, tc := range agg {
			tags = append(tags, *tc)
		}
		sort.Slice(tags, func(i, j int) bool { return tags[i].Tag < tags[j].Tag })
		out = overviewView{
			Feeds:   feeds,
			Tags:    tags,
			Recipes: db.core.Recipes,
			// Non-nil empty so an empty store serializes Out as [] (the
			// syndicate tab reads .length), mirroring the old listSyndicate.
			Out:       append([]OutFeed{}, db.core.Out...),
			Gen:       db.core.Gen,
			FetchedAt: db.core.FetchedAt,
			TotalArt:  db.core.TotalArticles,
			CdnURL:    globals.CdnURL,
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
