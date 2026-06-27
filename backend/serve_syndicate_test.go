package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestPutSyndicate(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "F", URL: "https://f.example/feed", Tag: "news"})

	body := `{"format":"rss","title":"My Feed","tags":["news"],"limit":10}`
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/mine", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	list := doReq(t, newMux(), "GET", "/api/syndicate", "")
	var got []OutFeed
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 1 || got[0].Name != "mine" || got[0].Limit != 10 {
		t.Fatalf("got %+v", got)
	}
}

func TestPutSyndicateBadFormat(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"xml","tags":["a"]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestPutSyndicateNoSelector(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestPutSyndicateUnknownFeed(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "PUT", "/api/syndicate/x", `{"format":"rss","feeds":[77]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteSyndicate(t *testing.T) {
	db, _, _ := setupTestDB(t)
	seedFeed(t, db, &Feed{Title: "F", URL: "https://f.example/feed", Tag: "news"})
	if put := doReq(t, newMux(), "PUT", "/api/syndicate/mine", `{"format":"rss","tags":["news"]}`); put.Code != http.StatusOK {
		t.Fatalf("setup PUT = %d (%s)", put.Code, put.Body)
	}
	rec := doReq(t, newMux(), "DELETE", "/api/syndicate/mine", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	list := doReq(t, newMux(), "GET", "/api/syndicate", "")
	var got []OutFeed
	json.Unmarshal(list.Body.Bytes(), &got)
	if len(got) != 0 {
		t.Fatalf("not deleted: %+v", got)
	}
}
