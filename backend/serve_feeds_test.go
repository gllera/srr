package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestListFeeds(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Beta", URL: "https://b.example/feed", Tag: "news", FailStreak: 4, FetchError: "boom", TotalArt: 12})
	seedFeed(t, db, &Feed{Title: "Alpha", URL: "https://a.example/feed", LastOK: 1700000000})

	rec := doReq(t, newMux(), "GET", "/api/feeds", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	// Sorted case-insensitively by title: Alpha before Beta.
	if got[0].Title != "Alpha" || got[1].Title != "Beta" {
		t.Fatalf("order = %q,%q want Alpha,Beta", got[0].Title, got[1].Title)
	}
	if got[1].FailStreak != 4 || got[1].Error != "boom" || got[1].TotalArt != 12 {
		t.Fatalf("health fields missing: %+v", got[1])
	}
}

func TestGetFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Only", URL: "https://o.example/feed"})

	rec := doReq(t, newMux(), "GET", "/api/feeds/0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != 0 || got.Title != "Only" {
		t.Fatalf("got %+v", got)
	}
}

func TestGetFeedNotFound(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/feeds/99", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
