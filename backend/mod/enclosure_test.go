package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runEnclosure processes an item with the given Raw entry and content
// through #enclosure, asserting the pipeline contract survived.
func runEnclosure(t *testing.T, raw RawFeedItem, content string) string {
	t.Helper()
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "T", Content: content, Link: "http://e.com", Published: &now, Raw: raw}
	if err := m.Process(context.Background(), "#enclosure", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.GUID != 7 || item.Published == nil || !item.Published.Equal(now) {
		t.Fatal("GUID/Published mutated")
	}
	if item.Title != "T" || item.Link != "http://e.com" {
		t.Fatal("Title/Link mutated")
	}
	return item.Content
}

// An RSS image enclosure the body never shows is prepended.
func TestEnclosureImagePrepended(t *testing.T) {
	raw := RawFeedItem{"enclosure": {{Attr: map[string]string{
		"url": "https://x.org/hero.jpg", "type": "image/jpeg"}}}}
	got := runEnclosure(t, raw, "<p>text</p>")
	if !strings.HasPrefix(got, `<p><img src="https://x.org/hero.jpg"/></p>`) {
		t.Fatalf("enclosure image should lead the content, got %q", got)
	}
	if !strings.HasSuffix(got, "<p>text</p>") {
		t.Errorf("original content should follow, got %q", got)
	}
}

// A podcast audio enclosure becomes a player with controls.
func TestEnclosureAudioPlayer(t *testing.T) {
	raw := RawFeedItem{"enclosure": {{Attr: map[string]string{
		"url": "https://x.org/ep1.mp3", "type": "audio/mpeg"}}}}
	got := runEnclosure(t, raw, "<p>shownotes</p>")
	if !strings.Contains(got, `<audio controls="" src="https://x.org/ep1.mp3"></audio>`) {
		t.Fatalf("audio player missing, got %q", got)
	}
}

// A video enclosure classified by URL extension (no type attr).
func TestEnclosureVideoByExtension(t *testing.T) {
	raw := RawFeedItem{"enclosure": {{Attr: map[string]string{"url": "https://x.org/clip.mp4"}}}}
	got := runEnclosure(t, raw, "")
	if !strings.Contains(got, `<video controls="" src="https://x.org/clip.mp4"></video>`) {
		t.Fatalf("video player missing, got %q", got)
	}
}

// media:content variants: the largest declared image wins.
func TestEnclosureMediaContentLargestWins(t *testing.T) {
	raw := RawFeedItem{"content": {
		{Attr: map[string]string{"url": "https://x.org/s.jpg", "type": "image/jpeg", "width": "150", "height": "150"}},
		{Attr: map[string]string{"url": "https://x.org/l.jpg", "type": "image/jpeg", "width": "1200", "height": "800"}},
	}}
	got := runEnclosure(t, raw, "<p>t</p>")
	if !strings.Contains(got, "l.jpg") || strings.Contains(got, "s.jpg") {
		t.Fatalf("largest media:content should win, got %q", got)
	}
}

// YouTube's media:group: the flash content entry is skipped, the thumbnail
// survives as the image.
func TestEnclosureMediaGroupThumbnail(t *testing.T) {
	raw := RawFeedItem{"group": {{Chld: RawFeedItem{
		"content":   {{Attr: map[string]string{"url": "https://www.youtube.com/v/abc123xyz00?version=3", "type": "application/x-shockwave-flash"}}},
		"thumbnail": {{Attr: map[string]string{"url": "https://i.ytimg.com/vi/abc123xyz00/hqdefault.jpg"}}},
	}}}}
	got := runEnclosure(t, raw, "")
	if !strings.Contains(got, `<img src="https://i.ytimg.com/vi/abc123xyz00/hqdefault.jpg"/>`) {
		t.Fatalf("group thumbnail should be prepended, got %q", got)
	}
	if strings.Contains(got, "youtube.com/v/") {
		t.Errorf("flash content entry must not be embedded, got %q", got)
	}
}

// A full image beats a thumbnail regardless of order.
func TestEnclosureFullImageBeatsThumbnail(t *testing.T) {
	raw := RawFeedItem{
		"thumbnail": {{Attr: map[string]string{"url": "https://x.org/t.jpg"}}},
		"enclosure": {{Attr: map[string]string{"url": "https://x.org/full.jpg", "type": "image/jpeg"}}},
	}
	got := runEnclosure(t, raw, "")
	if !strings.Contains(got, "full.jpg") || strings.Contains(got, "t.jpg\"") {
		t.Fatalf("full image should beat thumbnail, got %q", got)
	}
}

// An Atom link rel=enclosure carries the media in href.
func TestEnclosureAtomLink(t *testing.T) {
	raw := RawFeedItem{"link": {
		{Attr: map[string]string{"rel": "alternate", "href": "https://x.org/post"}},
		{Attr: map[string]string{"rel": "enclosure", "href": "https://x.org/pod.mp3", "type": "audio/mpeg"}},
	}}
	got := runEnclosure(t, raw, "<p>t</p>")
	if !strings.Contains(got, `src="https://x.org/pod.mp3"`) {
		t.Fatalf("atom enclosure link should be prepended, got %q", got)
	}
	if strings.Contains(got, "x.org/post") {
		t.Errorf("alternate link must not be treated as media, got %q", got)
	}
}

// An enclosure already visible in the body is not duplicated — exact URL
// and WordPress size-variant identity both count.
func TestEnclosureAlreadyPresentVerbatim(t *testing.T) {
	for _, body := range []string{
		`<p><img src="https://x.org/hero.jpg"></p>`,
		`<p><img src="https://x.org/hero-640x480.jpg"></p>`,
	} {
		raw := RawFeedItem{"enclosure": {{Attr: map[string]string{
			"url": "https://x.org/hero.jpg", "type": "image/jpeg"}}}}
		if got := runEnclosure(t, raw, body); got != body {
			t.Errorf("present media must not duplicate, body %q got %q", body, got)
		}
	}
}

// Non-http(s) URLs and unclassifiable types are ignored.
func TestEnclosureUnusableCandidatesVerbatim(t *testing.T) {
	raw := RawFeedItem{"enclosure": {
		{Attr: map[string]string{"url": "ftp://x.org/a.jpg", "type": "image/jpeg"}},
		{Attr: map[string]string{"url": "https://x.org/doc.pdf", "type": "application/pdf"}},
	}}
	in := "<p>t</p>"
	if got := runEnclosure(t, raw, in); got != in {
		t.Fatalf("unusable candidates must not change content, got %q", got)
	}
}

// Items without a parsed feed entry (external ingest) pass through.
func TestEnclosureNilRawVerbatim(t *testing.T) {
	m := New()
	item := &RawItem{Content: "<p>t</p>"}
	if err := m.Process(context.Background(), "#enclosure", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != "<p>t</p>" {
		t.Fatalf("nil Raw must be a no-op, got %q", item.Content)
	}
}

// enclosureKind classifies a candidate by MIME prefix, then the Media RSS
// medium attribute, then the URL extension. This pins the medium= tier (type and
// extension both absent), the MIME-wins precedence, and the empty result when
// nothing classifies.
func TestEnclosureKindMediumAttr(t *testing.T) {
	cases := []struct{ typ, medium, url, want string }{
		{"", "image", "https://x.org/pic", "image"}, // medium classifies (no type, no ext)
		{"", "video", "https://x.org/stream", "video"},
		{"", "audio", "https://x.org/track", "audio"},
		{"", "", "https://x.org/nope", ""},                  // no type, medium, or ext → ""
		{"image/jpeg", "video", "https://x.org/x", "image"}, // MIME prefix wins over medium
	}
	for _, c := range cases {
		if got := enclosureKind(c.typ, c.medium, c.url); got != c.want {
			t.Errorf("enclosureKind(%q,%q,%q) = %q, want %q", c.typ, c.medium, c.url, got, c.want)
		}
	}
}

// An <itunes:image href> (raw["image"]) is surfaced as a thumbnail-tier image.
func TestEnclosureItunesImage(t *testing.T) {
	raw := RawFeedItem{"image": {{Attr: map[string]string{"href": "https://x.org/cover.jpg"}}}}
	got := runEnclosure(t, raw, "<p>notes</p>")
	if !strings.Contains(got, `<img src="https://x.org/cover.jpg"/>`) {
		t.Fatalf("itunes:image should be prepended, got %q", got)
	}
}

// A media:content with no type and no URL extension falls back to the Media RSS
// medium attribute for its kind.
func TestEnclosureMediumAttrClassifiesVideo(t *testing.T) {
	raw := RawFeedItem{"content": {{Attr: map[string]string{
		"url": "https://x.org/stream", "medium": "video"}}}}
	got := runEnclosure(t, raw, "<p>t</p>")
	if !strings.Contains(got, `<video controls="" src="https://x.org/stream"></video>`) {
		t.Fatalf("medium=video should classify as video, got %q", got)
	}
}
