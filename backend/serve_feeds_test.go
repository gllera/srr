package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

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

	// Round-trip: it is now listed in the overview.
	ov := doReq(t, newMux(), "GET", "/api/overview", "")
	if !strings.Contains(ov.Body.String(), "https://n.example/feed") {
		t.Fatalf("created feed not listed in overview: %s", ov.Body)
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
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	body := `{"title":"X","url":"https://x.example/feed"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}

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
	// Verify deletion via direct DB read (GET /api/feeds/{id} was removed).
	err := withDB(false, func(_ context.Context, d *DB) error {
		_, e := d.FeedByID(0)
		if e == nil {
			t.Fatalf("feed 0 still exists after delete")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
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
	ov := doReq(t, newMux(), "GET", "/api/overview", "")
	var got overviewView
	json.Unmarshal(ov.Body.Bytes(), &got)
	if len(got.Feeds) != 2 {
		t.Fatalf("len = %d, want 2", len(got.Feeds))
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
	ov := doReq(t, newMux(), "GET", "/api/overview", "")
	var got overviewView
	json.Unmarshal(ov.Body.Bytes(), &got)
	if len(got.Feeds) != 0 {
		t.Fatalf("batch should be atomic; got %d feeds", len(got.Feeds))
	}
}

// A GUI feed save (PUT body without no_title) must not clobber a feed's stored
// titleless flag — setting it is scoped to the CLI (feed apply/edit).
func TestServeFeedUpdatePreservesNoTitle(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Chan", URL: "https://t.example.com/feed", NoTitle: true})

	// The exact body the webui edit modal sends: title/url/tag/recipe, no no_title.
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0",
		`{"title":"Chan renamed","url":"https://t.example.com/feed","tag":"news"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}

	// Read the persisted state (not the in-memory db which predates the handler).
	var noTitle bool
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		noTitle = ch.NoTitle
		return nil
	})
	if err != nil {
		t.Fatalf("FeedByID: %v", err)
	}
	if !noTitle {
		t.Errorf("NoTitle = false after GUI save, want true (must be preserved)")
	}
}
