package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"srrb/mod"
)

const sampleRSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>S</title>
<item><title>Hello</title><link>https://e.example/a</link><description>&lt;p&gt;Body&lt;/p&gt;</description></item>
</channel></rss>`

func TestPreview(t *testing.T) {
	setupTestDB(t)
	// A local RSS server; allow loopback fetch past the SSRF guard.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		w.Write([]byte(sampleRSS))
	}))
	t.Cleanup(srv.Close)
	prev := mod.AllowPrivateFetch
	mod.AllowPrivateFetch = true
	t.Cleanup(func() { mod.AllowPrivateFetch = prev })

	rec := doReq(t, newMux(), "GET", "/api/preview?url="+srv.URL, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	var got []previewArticle
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Title != "Hello" {
		t.Fatalf("got %+v", got)
	}
}

func TestPreviewRequiresURL(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/preview", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
