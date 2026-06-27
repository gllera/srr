package main

import (
	"context"
	"net/http"
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
}

func getOverview(w http.ResponseWriter, r *http.Request) {
	var out overviewView
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = overviewView{
			Feeds:   buildFeedViews(db),
			Tags:    buildTagCounts(db),
			Recipes: buildRecipeMap(db),
			// Non-nil empty so an empty store serializes Out as [] (the
			// syndicate tab reads .length), mirroring listSyndicate.
			Out:       append([]OutFeed{}, db.core.Out...),
			Gen:       db.core.Gen,
			FetchedAt: db.core.FetchedAt,
			TotalArt:  db.core.TotalArticles,
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
