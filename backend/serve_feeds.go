package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// feedListView is the read-only feed shape the GUI table consumes: the writable
// feedView fields plus server-owned health fields. Writes (POST/PUT) accept
// title/url/tag/recipe/ingest/pipe/no_title/expire_days — full-replace
// semantics, like `feed apply` (the edit modal always sends the no_title
// checkbox, expire_days, and the ingest/pipe override values).
type feedListView struct {
	ID         int      `json:"id"`
	Title      string   `json:"title"`
	URL        string   `json:"url"`
	Tag        string   `json:"tag,omitempty"`
	Recipe     string   `json:"recipe,omitempty"`
	Ingest     string   `json:"ingest,omitempty"`
	Pipe       []string `json:"pipe,omitempty"`
	NoTitle    bool     `json:"no_title,omitempty"`
	Error      string   `json:"error,omitempty"`
	FailStreak int      `json:"fail_streak"`
	LastOK     int64    `json:"last_ok"`
	LastNew    int64    `json:"last_new"`
	TotalArt   int      `json:"total_art"`
	ExpireDays int      `json:"expire_days,omitempty"`
	Expired    int      `json:"expired,omitempty"`
	// ContentBytes/AssetBytes are server-owned counters (see Feed): uncompressed
	// data-pack bytes added by the feed, and its live assets/ footprint.
	ContentBytes int64 `json:"content_bytes,omitempty"`
	AssetBytes   int64 `json:"asset_bytes,omitempty"`
}

func listViewOf(ch *Feed) feedListView {
	return feedListView{
		ID:           ch.id,
		Title:        ch.Title,
		URL:          ch.URL,
		Tag:          ch.Tag,
		Recipe:       ch.Recipe,
		Ingest:       ch.Ingest,
		Pipe:         ch.Pipe,
		NoTitle:      ch.NoTitle,
		Error:        ch.FetchError,
		FailStreak:   ch.FailStreak,
		LastOK:       ch.LastOK,
		LastNew:      ch.LastNew,
		TotalArt:     ch.TotalArt,
		ExpireDays:   ch.ExpireDays,
		Expired:      ch.Expired,
		ContentBytes: ch.ContentBytes,
		AssetBytes:   ch.AssetBytes,
	}
}

// saveFeed upserts one feedView, with the same subscribe-time discovery gating
// as `feed add`/`feed upd -u`: probe when the effective ingest is #feed and the
// URL is new (create) or changed (update). Shared by the POST and PUT handlers
// so the GUI matches the CLI. Returns the stored *Feed for echo-back.
func saveFeed(ctx context.Context, db *DB, v *feedView) (*Feed, error) {
	if v.Title == "" {
		return nil, fmt.Errorf("title required")
	}
	if !validFeedURL(v.URL) {
		return nil, fmt.Errorf("invalid url %q", v.URL)
	}
	isCreate := v.ID == nil
	var ch *Feed
	if isCreate {
		ch = &Feed{}
	} else {
		existing, err := db.FeedByID(*v.ID)
		if err != nil {
			return nil, err
		}
		ch = existing
	}
	resolved, err := resolveFeedProbe(ctx, db.core.Recipes, v.Recipe, v.Ingest, ch.URL, v.URL)
	if err != nil {
		return nil, err
	}
	v.URL = resolved // fold the resolved URL back in, then reuse the shared field-writer
	writeFeedView(ch, v)
	if err := normalizeFeed(ch, db.core.Recipes); err != nil {
		return nil, err
	}
	if isCreate {
		if err := db.AddFeed(ch); err != nil {
			return nil, err
		}
	}
	return ch, db.Commit(ctx)
}

func updateFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	handleFeedSave(w, r, &id)
}

// handleFeedSave decodes a feedView, stamps its id (nil = create, non-nil =
// update), upserts via saveFeed, and echoes the stored feed. Shared by
// createFeed + updateFeed.
func handleFeedSave(w http.ResponseWriter, r *http.Request, id *int) {
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = id
	var saved *Feed
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		s, e := saveFeed(ctx, db, &v)
		saved = s
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listViewOf(saved))
}

func deleteFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		if _, e := db.FeedByID(id); e != nil {
			return e // 404 when absent
		}
		db.RemoveFeed(id)
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func createFeed(w http.ResponseWriter, r *http.Request) {
	handleFeedSave(w, r, nil) // nil id ⇒ create (any id in the body is ignored)
}

func applyFeedsHandler(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := parseApplyInput(data)
	if err != nil {
		writeErr(w, err)
		return
	}
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return applyViews(ctx, db, views)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": len(views)})
}

// tagCount is one tag bucket for the GUI tag filter. Tag "" is the untagged
// bucket. Unlike `srr inspect --list-tags`, feeds with 0 articles are counted
// so brand-new feeds' tags still appear in the filter.
type tagCount struct {
	Tag      string `json:"tag"`
	Feeds    int    `json:"feeds"`
	Articles int    `json:"articles"`
}
