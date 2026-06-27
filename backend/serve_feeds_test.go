package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
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

// stubResolve makes subscribe-time discovery a no-op (offline) for the test.
func stubResolve(t *testing.T) {
	t.Helper()
	prev := resolveFeedURL
	resolveFeedURL = func(_ context.Context, url string) (string, error) { return url, nil }
	t.Cleanup(func() { resolveFeedURL = prev })
}

func TestCreateFeed(t *testing.T) {
	setupTestDB(t)
	stubResolve(t)
	body := `{"title":"New","url":"https://n.example/feed","tag":"news"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != 0 || got.Title != "New" || got.Tag != "news" {
		t.Fatalf("got %+v", got)
	}

	// Round-trip: it is now listed.
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	if !strings.Contains(list.Body.String(), "https://n.example/feed") {
		t.Fatalf("created feed not listed: %s", list.Body)
	}
}

func TestCreateFeedBadRecipe(t *testing.T) {
	setupTestDB(t)
	stubResolve(t)
	body := `{"title":"X","url":"https://x.example/feed","recipe":"nope"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreateFeedLockContention(t *testing.T) {
	db, _, dir := setupTestDB(t)
	_ = db
	stubResolve(t)
	// Hold the lock the way another srr process would.
	lock := dir + "/" + dbLockKey
	if err := osWriteFile(lock); err != nil {
		t.Fatal(err)
	}
	body := `{"title":"X","url":"https://x.example/feed"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}

func osWriteFile(path string) error { return os.WriteFile(path, nil, 0o644) }
