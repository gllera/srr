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
	// DedupDays is the *effective* store-wide default seen.gz horizon (the
	// stored DBCore.DedupDays, or the built-in default when unset/≤0) — the
	// Tools tab renders and edits it. Always present so the webui needn't know
	// the built-in default.
	DedupDays int `json:"dedup_days"`
	// CdnURL lets the syndicate tab link the produced out/<name> files;
	// omitted when SRR_CDN_URL is unset (syndication writes are skipped then).
	CdnURL string `json:"cdn_url,omitempty"`
	// Version is the running binary's version ("development" outside release
	// builds — main.go's ldflags var), so the webui can label itself.
	Version string `json:"version"`
}

// buildOverview projects an already-open DB into the overview snapshot. It is
// the whole body of the `/api/overview` handler, factored out so other
// consumers of the same projection (the MCP tool layer) wrap it instead of
// forking it — the wire shape stays defined in exactly one place. The caller
// owns the DB scope; this takes no lock and reads nothing from the store.
func buildOverview(db *DB) overviewView {
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
		// Live count: TotalArt is all-time, Expired articles are gone from
		// the store — the overview is a display projection.
		tc.Articles += ch.TotalArt - ch.Expired
	}
	tags := make([]tagCount, 0, len(agg))
	for _, tc := range agg {
		tags = append(tags, *tc)
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i].Tag < tags[j].Tag })
	return overviewView{
		Feeds:   feeds,
		Tags:    tags,
		Recipes: db.core.Recipes,
		// Non-nil empty so an empty store serializes Out as [] (the
		// syndicate tab reads .length), mirroring the old listSyndicate.
		Out:       append([]OutFeed{}, db.core.Out...),
		Gen:       db.core.Gen,
		FetchedAt: db.core.FetchedAt,
		TotalArt:  db.core.TotalArticles,
		DedupDays: effectiveStoreDedup(db.core.DedupDays),
		CdnURL:    globals.CdnURL,
		Version:   version,
	}
}

func getOverview(w http.ResponseWriter, r *http.Request) {
	var out overviewView
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = buildOverview(db)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
