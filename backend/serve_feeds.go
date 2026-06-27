package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// feedListView is the read-only feed shape the GUI table consumes: the writable
// feedView fields plus server-owned health fields. Writes (POST/PUT) accept only
// the feedView subset (title/url/tag/recipe).
type feedListView struct {
	ID         int    `json:"id"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	Tag        string `json:"tag,omitempty"`
	Recipe     string `json:"recipe,omitempty"`
	Error      string `json:"error,omitempty"`
	FailStreak int    `json:"fail_streak"`
	LastOK     int64  `json:"last_ok"`
	LastNew    int64  `json:"last_new"`
	TotalArt   int    `json:"total_art"`
}

func listViewOf(ch *Feed) feedListView {
	return feedListView{
		ID:         ch.id,
		Title:      ch.Title,
		URL:        ch.URL,
		Tag:        ch.Tag,
		Recipe:     ch.Recipe,
		Error:      ch.FetchError,
		FailStreak: ch.FailStreak,
		LastOK:     ch.LastOK,
		LastNew:    ch.LastNew,
		TotalArt:   ch.TotalArt,
	}
}

func listFeeds(w http.ResponseWriter, r *http.Request) {
	var out []feedListView
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = make([]feedListView, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			out = append(out, listViewOf(ch))
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	writeJSON(w, http.StatusOK, out)
}

func getFeed(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	var view feedListView
	err = withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		ch, e := db.FeedByID(id)
		if e != nil {
			return e
		}
		view = listViewOf(ch)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
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
	if err := validateRecipeRef(db.core.Recipes, v.Recipe); err != nil {
		return nil, err
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
	newURL := v.URL
	if ch.URL != newURL && resolvesFeed(db.core.Recipes, v.Recipe) {
		resolved, err := resolveFeedURL(ctx, newURL)
		if err != nil {
			return nil, fmt.Errorf("resolve feed %q: %w", newURL, err)
		}
		newURL = resolved
	}
	ch.Title = v.Title
	setFeedURL(ch, newURL)
	ch.Tag = v.Tag
	ch.Recipe = v.Recipe
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
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = &id
	var saved *Feed
	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
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
	var v feedView
	if err := decodeJSON(r, &v); err != nil {
		writeErr(w, err)
		return
	}
	v.ID = nil // create ignores any id in the body
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
