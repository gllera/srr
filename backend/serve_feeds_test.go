package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestCreateFeed(t *testing.T) {
	setupTestDB(t)
	stubPassthroughResolve()
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
	stubPassthroughResolve()
	body := `{"title":"X","url":"https://x.example/feed","recipe":"nope"}`
	rec := doReq(t, newMux(), "POST", "/api/feeds", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCreateFeedLockContention(t *testing.T) {
	_, _, dir := setupTestDB(t)
	stubPassthroughResolve()
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
	stubPassthroughResolve()
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
	stubPassthroughResolve()
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

// A GUI feed save carries the titleless flag (the edit modal checkbox), so a
// PUT sets and clears it with full-replace semantics like `feed apply`.
func TestServeFeedSaveRoundTripsNoTitle(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "Chan", URL: "https://t.example.com/feed"})

	// Read the persisted state (not the in-memory db which predates the handler).
	readNoTitle := func() bool {
		t.Helper()
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
		return noTitle
	}

	rec := doReq(t, newMux(), "PUT", "/api/feeds/0",
		`{"title":"Chan","url":"https://t.example.com/feed","no_title":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}
	if !readNoTitle() {
		t.Errorf("NoTitle = false after PUT with no_title:true, want true")
	}

	// Unchecked box ⇒ the body carries no_title:false, clearing the flag.
	rec = doReq(t, newMux(), "PUT", "/api/feeds/0",
		`{"title":"Chan","url":"https://t.example.com/feed","no_title":false}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body.String())
	}
	if readNoTitle() {
		t.Errorf("NoTitle = true after PUT with no_title:false, want false")
	}
}

func TestServeFeedExpireDaysRoundTrip(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	old := &Feed{Title: "Old", URL: "https://u.example/feed"}
	seedFeed(t, db, old)
	// Expired is server-owned state (AddFeed zeroes it on create), so the
	// fixture sets it post-add and re-commits.
	old.Expired = 7
	if err := db.Commit(context.Background()); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// expire_days is writable; expired is server-owned (like error) — a
	// client echoing it back must not overwrite the counter.
	body := `{"title":"Old","url":"https://u.example/feed","expire_days":30,"expired":99}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got feedListView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ExpireDays != 30 || got.Expired != 7 {
		t.Fatalf("echo expire_days=%d expired=%d, want 30/7", got.ExpireDays, got.Expired)
	}
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		if ch.ExpireDays != 30 || ch.Expired != 7 {
			t.Fatalf("stored ExpireDays=%d Expired=%d, want 30/7", ch.ExpireDays, ch.Expired)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestServeFeedSaveOmittedExpireDaysZeroes(t *testing.T) {
	db, _, _ := setupTestDB(t)
	stubPassthroughResolve()
	seedFeed(t, db, &Feed{Title: "Old", URL: "https://u.example/feed", ExpireDays: 30})

	// Full-replace semantics: a body omitting expire_days clears it — the
	// reason the webui modal must always send the field.
	body := `{"title":"Old","url":"https://u.example/feed"}`
	rec := doReq(t, newMux(), "PUT", "/api/feeds/0", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	err := withDB(false, func(_ context.Context, d *DB) error {
		ch, e := d.FeedByID(0)
		if e != nil {
			return e
		}
		if ch.ExpireDays != 0 {
			t.Fatalf("ExpireDays = %d, want 0 (full replace)", ch.ExpireDays)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

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
