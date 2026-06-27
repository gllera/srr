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

func TestUpdateFeedPreservesStateOnSameURL(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", FailStreak: 3, FetchError: "x"})

	body := `{"title":"Renamed","url":"https://u.example/feed","tag":"news"}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	// Same URL ⇒ fetch state preserved.
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		if ch.Title != "Renamed" || ch.Tag != "news" {
			t.Fatalf("not updated: %+v", ch)
		}
		if ch.FailStreak != 3 || ch.FetchError != "x" {
			t.Fatalf("fetch state should be preserved: %+v", ch)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUpdateFeedResetsStateOnNewURL(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubResolve(t)
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", FailStreak: 3, FetchError: "x"})

	body := `{"title":"Old","url":"https://v.example/feed"}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		if ch.URL != "https://v.example/feed" || ch.FailStreak != 0 || ch.FetchError != "" {
			t.Fatalf("new URL should reset state: %+v", ch)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDeleteFeed(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Doomed", URL: "https://d.example/feed"})

	rec := doReq(t, newMux(), "DELETE", "/api/feeds/0", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	get := doReq(t, newMux(), "GET", "/api/feeds/0", "")
	if get.Code != http.StatusNotFound {
		t.Fatalf("after delete GET = %d, want 404", get.Code)
	}
}

func TestDeleteFeedNotFound(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "DELETE", "/api/feeds/42", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestApplyFeedsArray(t *testing.T) {
	setupTestDB(t)
	body := `[{"title":"One","url":"https://1.example/feed"},{"title":"Two","url":"https://2.example/feed","tag":"news"}]`
	rec := doReq(t, newMux(), "POST", "/api/feeds/apply", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	var got []feedListView
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
}

func TestApplyFeedsAtomicOnBadElement(t *testing.T) {
	setupTestDB(t)
	// Second element has no url ⇒ whole batch rejected, nothing persisted.
	body := `[{"title":"Good","url":"https://g.example/feed"},{"title":"Bad"}]`
	rec := doReq(t, newMux(), "POST", "/api/feeds/apply", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	list := doReq(t, newMux(), "GET", "/api/feeds", "")
	var got []feedListView
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 0 {
		t.Fatalf("batch should be atomic; got %d feeds", len(got))
	}
}

func TestListTags(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "A", URL: "https://a.example/feed", Tag: "news", TotalArt: 5})
	seedFeed(t, db, &Feed{Title: "B", URL: "https://b.example/feed", Tag: "news", TotalArt: 3})
	seedFeed(t, db, &Feed{Title: "C", URL: "https://c.example/feed"}) // untagged

	rec := doReq(t, newMux(), "GET", "/api/tags", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got []tagCount
	json.Unmarshal(rec.Body.Bytes(), &got)
	var news *tagCount
	for i := range got {
		if got[i].Tag == "news" {
			news = &got[i]
		}
	}
	if news == nil || news.Feeds != 2 || news.Articles != 8 {
		t.Fatalf("news tag wrong: %+v (all: %+v)", news, got)
	}
}
