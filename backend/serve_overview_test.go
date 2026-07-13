package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// TestOverview asserts the one snapshot endpoint hands the webui the whole store
// in a single request — feeds (UI-projected), the derived tags, recipes, the
// syndication outputs, gen and scalars — so every read-tab needs one store read.
func TestOverview(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Beta", URL: "https://b.example/feed", Tag: "news", TotalArt: 3, FetchError: "boom", FailStreak: 4})
	seedFeed(t, db, &Feed{Title: "Alpha", URL: "https://a.example/feed"}) // untagged

	rec := doReq(t, newMux(), "GET", "/api/overview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got overviewView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Feeds: both present, sorted case-insensitively by title, with the UI-shape
	// id + friendly error (not the wire `ferr`).
	if len(got.Feeds) != 2 || got.Feeds[0].Title != "Alpha" || got.Feeds[1].Title != "Beta" {
		t.Fatalf("feeds = %+v, want [Alpha, Beta]", got.Feeds)
	}
	if got.Feeds[1].Error != "boom" || got.Feeds[1].FailStreak != 4 {
		t.Fatalf("feed health fields missing: %+v", got.Feeds[1])
	}
	// Tags: the news bucket counts its one feed; the untagged bucket exists too.
	var news *tagCount
	for i := range got.Tags {
		if got.Tags[i].Tag == "news" {
			news = &got.Tags[i]
		}
	}
	if news == nil || news.Feeds != 1 || news.Articles != 3 {
		t.Fatalf("news tag wrong: %+v (all: %+v)", news, got.Tags)
	}
	// Recipes: the seeded store always carries the reserved default recipe.
	if _, ok := got.Recipes[defaultRecipeName]; !ok {
		t.Fatalf("recipes missing %q: %+v", defaultRecipeName, got.Recipes)
	}
	// Out: empty store ⇒ a non-nil empty slice (serialized as [], the syndicate
	// tab reads .length). gen/scalars start at 0.
	if got.Out == nil || len(got.Out) != 0 {
		t.Fatalf("out = %+v, want []", got.Out)
	}
	if got.Gen != 0 || got.TotalArt != 0 {
		t.Fatalf("gen=%d total_art=%d, want 0,0", got.Gen, got.TotalArt)
	}
	// Version: the running binary's version rides the snapshot so the webui can
	// label itself ("development" here; release ldflags set the real tag).
	if got.Version != "development" {
		t.Fatalf("version = %q, want %q", got.Version, "development")
	}
}

// TestOverviewTagCountsAreLive pins the overview tag buckets to LIVE article
// counts (TotalArt − Expired), the display math the frontend mirrors. (Moved
// here from serve_feeds_test.go — it belongs with the overview tests.)
func TestOverviewTagCountsAreLive(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f", Tag: "news", TotalArt: 10}
	seedFeed(t, db, a)
	// Expired is server-owned state (AddFeed zeroes it on create), so the
	// fixture sets it post-add and re-commits.
	a.Expired = 4
	if err := db.Commit(context.Background()); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	rec := doReq(t, newMux(), "GET", "/api/overview", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var ov overviewView
	if err := json.Unmarshal(rec.Body.Bytes(), &ov); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(ov.Tags) != 1 || ov.Tags[0].Articles != 6 {
		t.Fatalf("tags = %+v, want one bucket with 6 live articles", ov.Tags)
	}
}

// TestOverviewCarriesStoreDedupDefault pins the overview to the *effective*
// store-wide dedup default (the built-in when unset, else the stored value) so
// the Tools tab can render and edit it without knowing the built-in constant.
func TestOverviewCarriesStoreDedupDefault(t *testing.T) {
	db, _, _ := setupTestDB(t)

	rec := doReq(t, newMux(), "GET", "/api/overview", "")
	var got overviewView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.DedupDays != defaultDedupDays {
		t.Fatalf("dedup_days = %d, want built-in default %d when unset", got.DedupDays, defaultDedupDays)
	}

	db.core.DedupDays = 7
	if err := db.Commit(context.Background()); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	rec = doReq(t, newMux(), "GET", "/api/overview", "")
	got = overviewView{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.DedupDays != 7 {
		t.Fatalf("dedup_days = %d, want the stored 7", got.DedupDays)
	}
}

// TestOverviewCdnURL asserts the overview carries the configured CDN URL (so
// the syndicate tab can link the produced out/<name> files), omitted when unset.
func TestOverviewCdnURL(t *testing.T) {
	setupTestDB(t)
	prev := globals.CdnURL
	globals.CdnURL = "https://cdn.example/store"
	t.Cleanup(func() { globals.CdnURL = prev })

	rec := doReq(t, newMux(), "GET", "/api/overview", "")
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["cdn_url"] != "https://cdn.example/store" {
		t.Fatalf("cdn_url = %v, want the configured CDN URL", got["cdn_url"])
	}

	globals.CdnURL = ""
	rec = doReq(t, newMux(), "GET", "/api/overview", "")
	got = map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, present := got["cdn_url"]; present {
		t.Fatalf("cdn_url should be omitted when unset, got %v", got["cdn_url"])
	}
}
