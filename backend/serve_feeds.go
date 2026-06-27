package main

import (
	"context"
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
