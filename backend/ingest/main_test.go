package ingest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
		{"channel-overrides-default", "#telegram", "", "#telegram"},
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
	f := New()
	for _, name := range []string{"#rss", "#telegram"} {
		if _, ok := f.fetchers[name]; !ok {
			t.Errorf("built-in %q is not registered", name)
		}
	}
}

// TestTelegramFetcherParsesMessages confirms the parser pulls (link,
// content, published) out of a realistic Telegram preview-page block.
// Two messages are included: one normal with text, one with an inline
// link inside the text — both must round-trip the inner HTML so the
// downstream sanitize/minify pipeline gets the raw structure.
func TestTelegramFetcherParsesMessages(t *testing.T) {
	const page = `<!doctype html><html><body>
<div class="tgme_channel_info_header">
  <div class="tgme_channel_info_header_title_wrap">
    <div class="tgme_channel_info_header_title"><span dir="auto">My Channel</span></div>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message default" data-post="ch/1">
    <div class="tgme_widget_message_text js-message_text">Hello <b>world</b></div>
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/ch/1">
        <time datetime="2024-01-15T10:30:00+00:00" class="time">10:30</time>
      </a>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message default" data-post="ch/2">
    <div class="tgme_widget_message_text js-message_text">See <a href="https://example.com">link</a></div>
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/ch/2">
        <time datetime="2024-01-15T11:00:00+00:00" class="time">11:00</time>
      </a>
    </div>
  </div>
</div>
</body></html>`

	items, err := parseTelegramHTML([]byte(page))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}

	if items[0].Link != "https://t.me/ch/1" {
		t.Errorf("items[0].Link = %q, want https://t.me/ch/1", items[0].Link)
	}
	if items[0].Title != "My Channel" || items[1].Title != "My Channel" {
		t.Errorf("titles = %q,%q, want both %q", items[0].Title, items[1].Title, "My Channel")
	}
	if !strings.Contains(items[0].Content, "Hello") || !strings.Contains(items[0].Content, "<b>world</b>") {
		t.Errorf("items[0].Content lost formatting: %q", items[0].Content)
	}
	if items[0].Published == nil || items[0].Published.Unix() != 1705314600 {
		t.Errorf("items[0].Published = %v, want 2024-01-15T10:30:00Z", items[0].Published)
	}

	if !strings.Contains(items[1].Content, `href="https://example.com"`) {
		t.Errorf("items[1] missing inline link: %q", items[1].Content)
	}

	if items[0].GUID == items[1].GUID {
		t.Errorf("GUIDs should differ for distinct posts")
	}
	if items[0].GUID != hash("ch/1") {
		t.Errorf("GUID is not hash(data-post)")
	}
}

// When the preview page lacks a channel header (defensive case),
// the Title falls back to the channel handle from data-post.
func TestTelegramFetcherTitleFallsBackToHandle(t *testing.T) {
	const page = `<!doctype html><html><body>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message default" data-post="some_channel/42">
    <div class="tgme_widget_message_text js-message_text">hi</div>
    <a class="tgme_widget_message_date" href="https://t.me/some_channel/42">
      <time datetime="2024-04-01T00:00:00+00:00" class="time">00:00</time>
    </a>
  </div>
</div>
</body></html>`

	items, err := parseTelegramHTML([]byte(page))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Title != "some_channel" {
		t.Errorf("Title = %q, want %q", items[0].Title, "some_channel")
	}
}

// Video-duration <time> nodes also exist inside a message bubble; the
// parser must not mistake them for the publish timestamp.
func TestTelegramFetcherIgnoresVideoDurationTime(t *testing.T) {
	const page = `<!doctype html><html><body>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message default" data-post="ch/9">
    <div class="tgme_widget_message_video_wrap">
      <time class="message_video_duration">0:42</time>
    </div>
    <div class="tgme_widget_message_text js-message_text">video</div>
    <a class="tgme_widget_message_date" href="https://t.me/ch/9">
      <time datetime="2024-02-01T00:00:00+00:00" class="time">00:00</time>
    </a>
  </div>
</div>
</body></html>`

	items, err := parseTelegramHTML([]byte(page))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
	if items[0].Published == nil || items[0].Published.Unix() != 1706745600 {
		t.Errorf("Published = %v, want 2024-02-01T00:00:00Z", items[0].Published)
	}
}

func TestValidateTelegramURL(t *testing.T) {
	ok := []string{
		"https://t.me/s/durov",
		"https://t.me/s/some_channel",
	}
	bad := []string{
		"https://example.com/s/durov",
		"https://t.me/durov", // missing /s/
		"https://t.me/s/",    // empty channel
		"://broken",
	}
	for _, u := range ok {
		if err := validateTelegramURL(u); err != nil {
			t.Errorf("validateTelegramURL(%q) = %v, want nil", u, err)
		}
	}
	for _, u := range bad {
		if err := validateTelegramURL(u); err == nil {
			t.Errorf("validateTelegramURL(%q) = nil, want error", u)
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
	got, err := New().Fetch(context.Background(), cmd, nil, nil, Request{URL: "https://x", MaxSize: 1024})
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
	got, err := New().Fetch(context.Background(), cmd, nil, nil, Request{URL: "https://x", MaxSize: 1024})
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
