package ingest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSelectPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		chanFetcher   string
		globalFetcher string
		want          string
	}{
		{"channel-wins", "chan", "glob", "chan"},
		{"global-when-channel-empty", "", "glob", "glob"},
		{"default-when-all-empty", "", "", "#rss"},
		{"channel-overrides-default", "#custom", "", "#custom"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Select(tt.chanFetcher, tt.globalFetcher); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuiltinsRegistered(t *testing.T) {
	f := New(Deps{})
	for _, name := range []string{"#rss"} {
		if _, ok := f.fetchers[name]; !ok {
			t.Errorf("built-in %q is not registered", name)
		}
	}
}

// TestExternalFetcherProtocol round-trips a request through a real shell
// pipeline: a canned response file is emitted to stdout. Confirms
// encode/decode + RFC3339 published parsing. Items on the wire are
// mod.RawItem records, so the external fetcher emits an already-hashed
// uint32 GUID.
func TestExternalFetcherProtocol(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh available")
	}

	dir := t.TempDir()
	resp := filepath.Join(dir, "resp.json")
	guid := hash("abc")
	payload := fmt.Sprintf(`{"etag":"e1","last_modified":"lm1","items":[{"guid":%d,"title":"T","content":"C","link":"https://x/1","published":"2024-03-01T12:00:00Z"}]}`, guid)
	if err := os.WriteFile(resp, []byte(payload), 0644); err != nil {
		t.Fatalf("write resp: %v", err)
	}

	cmd := "cat > /dev/null; cat " + resp
	got, err := New(Deps{}).Fetch(context.Background(), cmd, nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got.ETag != "e1" || got.LastModified != "lm1" {
		t.Errorf("etag/last_modified roundtrip lost: %+v", got)
	}
	if len(got.Items) != 1 {
		t.Fatalf("got %d items, want 1", len(got.Items))
	}
	if got.Items[0].GUID != guid {
		t.Errorf("GUID round-trip lost: got %d, want %d", got.Items[0].GUID, guid)
	}
	if got.Items[0].Published == nil || got.Items[0].Published.Unix() != 1709294400 {
		t.Errorf("Published = %v, want 2024-03-01T12:00:00Z", got.Items[0].Published)
	}
}

func TestExternalFetcherNotModified(t *testing.T) {
	dir := t.TempDir()
	resp := filepath.Join(dir, "resp.json")
	if err := os.WriteFile(resp, []byte(`{"not_modified":true,"etag":"e2"}`), 0644); err != nil {
		t.Fatalf("write resp: %v", err)
	}

	cmd := "cat > /dev/null; cat " + resp
	got, err := New(Deps{}).Fetch(context.Background(), cmd, nil, nil, Request{URL: "https://x", MaxSize: 1024})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !got.NotModified {
		t.Errorf("not_modified roundtrip lost")
	}
	if got.ETag != "e2" {
		t.Errorf("etag roundtrip lost: %q", got.ETag)
	}
}
