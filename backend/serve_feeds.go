package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
)

// feedListView is the read-only feed shape the GUI table consumes: the feedView
// projection (so every writable field round-trips — the GUI's full-replace save
// would silently wipe one it lacked) plus server-owned health fields. Writes
// (POST/PUT) accept title/url/tag/recipe/ingest/pipe/no_title/expire_days/
// dedup_days/dedup_title — full-replace semantics, like `feed apply` (the edit
// modal always sends the no_title checkbox, expire_days, the dedup pool
// overrides, and the ingest/pipe override values).
type feedListView struct {
	feedView
	// ID shadows feedView's *int (for encoding/json and jsonschema-go alike):
	// a listed feed always has one, so "id" stays a required plain int.
	ID         int   `json:"id"`
	FailStreak int   `json:"fail_streak"`
	LastOK     int64 `json:"last_ok"`
	LastNew    int64 `json:"last_new"`
	TotalArt   int   `json:"total_art"`
}

func listViewOf(ch *Feed) feedListView {
	return feedListView{
		feedView:   *viewOf(ch),
		ID:         ch.id,
		FailStreak: ch.FailStreak,
		LastOK:     ch.LastOK,
		LastNew:    ch.LastNew,
		TotalArt:   ch.TotalArt,
	}
}

// resolveFeedViewURL runs subscribe-time discovery on a feedView read-only,
// folding the resolved URL back into v.URL: probe when the effective ingest is
// #feed and the URL is new (create) or changed (update). Kept OUT of the locked
// write path (saveFeedTwoPhase calls it in a no-lock DB scope first) so the
// network probe never holds .locked — which would 409 the fetch loop and every
// other mutation for its duration.
func resolveFeedViewURL(ctx context.Context, db *DB, v *feedView) error {
	// Offline field checks before the probe, so bad input never triggers a fetch.
	if err := validateFeedFields(v.ExpireDays, v.DedupDays, v.Ingest, v.Pipe, v.Tag); err != nil {
		return err
	}
	oldURL := ""
	if v.ID != nil {
		existing, err := db.FeedByID(*v.ID)
		if err != nil {
			return err
		}
		oldURL = existing.URL
	}
	resolved, err := resolveFeedProbe(ctx, db.core.Recipes, v.Recipe, v.Ingest, oldURL, v.URL)
	if err != nil {
		return err
	}
	v.URL = resolved
	return nil
}

// saveFeed upserts one feedView (URL already resolved by resolveFeedViewURL) —
// saveFeedTwoPhase's locked half, so every surface writes a feed the same way.
// requireTitle rejects a view whose title is empty; see saveFeedTwoPhase for
// which surfaces ask for it. Returns the stored *Feed for echo-back.
func saveFeed(ctx context.Context, db *DB, v *feedView, requireTitle bool) (*Feed, error) {
	if requireTitle && v.Title == "" {
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
	// v.URL is already resolved by resolveFeedViewURL (run outside the lock);
	// the field-writer just folds it in. No network probe on this locked path.
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

// saveFeedTwoPhase is the two-phase feed upsert every writing surface shares
// (the HTTP handlers, the MCP tools, `feed add` and `feed upd`): phase 1 (NO lock) builds the target
// view inside a read-only DB scope and runs subscribe-time discovery —
// networked, so it must never hold .locked, which would 409 the fetch loop and
// every other writer for the probe's duration — and phase 2 (locked) applies
// the write with the already-resolved URL. build produces the view inside
// phase 1's scope, so an update's merge base and its discovery probe come from
// ONE consistent db.gz read.
//
// requireTitle is the one rule the surfaces do NOT share. The creates (`feed
// add`, srr_add_feed) and the admin API's full-replace save reject a view whose
// title is empty; the partial updates (`feed upd`, srr_update_feed) pass false,
// because their view merges the STORED title and a store can hold an empty one
// (`store import` titles a feed from its outline's title= else text=, "" when
// it has neither). Rejecting that would refuse every other edit of such a feed,
// so they refuse only an explicit empty title (updateFeedIn.titleErr).
func saveFeedTwoPhase(ctx context.Context, requireTitle bool, build func(db *DB) (*feedView, error)) (*Feed, error) {
	var v *feedView
	if err := withDBCtx(ctx, false, func(ctx context.Context, db *DB) error {
		built, err := build(db)
		if err != nil {
			return err
		}
		v = built
		return resolveFeedViewURL(ctx, db, v)
	}); err != nil {
		return nil, err
	}
	var saved *Feed
	err := withDBCtx(ctx, true, func(ctx context.Context, db *DB) error {
		s, err := saveFeed(ctx, db, v, requireTitle)
		saved = s
		return err
	})
	return saved, err
}

// handleFeedSave decodes a feedView, stamps its id (nil = create, non-nil =
// update), upserts via saveFeedTwoPhase, and echoes the stored feed. Shared by
// createFeed + updateFeed.
func handleFeedSave(w http.ResponseWriter, r *http.Request, id *int) {
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = id
	saved, err := saveFeedTwoPhase(r.Context(), true, func(*DB) (*feedView, error) { return &v, nil })
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
	mutateStore(w, r, "deleted", func(ctx context.Context, db *DB) error {
		if _, e := db.FeedByID(id); e != nil {
			return e // 404 when absent
		}
		if e := db.RemoveFeed(ctx, id); e != nil {
			return e
		}
		return db.Commit(ctx)
	})
}

func createFeed(w http.ResponseWriter, r *http.Request) {
	handleFeedSave(w, r, nil) // nil id ⇒ create (any id in the body is ignored)
}

func applyFeedsHandler(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
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
