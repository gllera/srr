package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestExtractYouTubeID(t *testing.T) {
	cases := []struct {
		link string
		want string
	}{
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"http://youtube.com/watch?v=dQw4w9WgXcQ&feature=share", "dQw4w9WgXcQ"},
		{"https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"},
		{"https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"},
		{"https://www.youtube.com/embed/dQw4w9WgXcQ/?autoplay=1", "dQw4w9WgXcQ"},

		{"", ""},
		{"https://example.com/watch?v=dQw4w9WgXcQ", ""},
		{"https://www.youtube.com/", ""},
		{"https://www.youtube.com/watch", ""},
		{"https://www.youtube.com/watch?v=tooshort", ""},
		{"https://www.youtube.com/watch?v=this_is_too_long_to_be_a_youtube_id", ""},
		{"https://www.youtube.com/watch?v=bad+chars=", ""},
		{"not a url", ""},
	}
	for _, c := range cases {
		got := extractYouTubeID(c.link)
		if got != c.want {
			t.Errorf("extractYouTubeID(%q) = %q, want %q", c.link, got, c.want)
		}
	}
}

func TestYouTubeModSkipsNonYouTubeLinks(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{
		GUID:      1,
		Title:     "Plain article",
		Content:   "<p>Original</p>",
		Link:      "https://example.com/article",
		Published: &now,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Content != "<p>Original</p>" {
		t.Errorf("non-YouTube link should not be touched, got %q", item.Content)
	}
}

func TestYouTubeModEmbedsThumbnail(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{
		GUID:      1,
		Title:     `Cool & "Quoted" Video`,
		Link:      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		Published: &now,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	want := []string{
		`href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"`,
		`src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"`,
		`alt="Cool &amp; &#34;Quoted&#34; Video"`,
	}
	for _, w := range want {
		if !strings.Contains(item.Content, w) {
			t.Errorf("content missing %q\n got: %s", w, item.Content)
		}
	}
}

func TestYouTubeModUsesMediaDescription(t *testing.T) {
	m := New()
	now := time.Now()

	raw := RawFeedItem{
		"link": []RawField{{Attr: map[string]string{"href": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}}},
		"group": []RawField{{
			Chld: RawFeedItem{
				"description": []RawField{{Txt: "First line\nSecond line\n\nNew paragraph https://example.com end."}},
			},
		}},
	}
	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		Content:   "",
		Published: &now,
		Raw:       raw,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}

	checks := []string{
		`<p>First line<br>Second line</p>`,
		`<p>New paragraph <a href="https://example.com">https://example.com</a> end.</p>`,
	}
	for _, w := range checks {
		if !strings.Contains(item.Content, w) {
			t.Errorf("content missing %q\n got: %s", w, item.Content)
		}
	}
}

func TestYouTubeModFallsBackToEntryDescription(t *testing.T) {
	m := New()
	now := time.Now()

	raw := RawFeedItem{
		"description": []RawField{{Txt: "fallback desc"}},
	}
	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Published: &now,
		Raw:       raw,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !strings.Contains(item.Content, "<p>fallback desc</p>") {
		t.Errorf("expected fallback description, got %q", item.Content)
	}
}

func TestYouTubeModFallsBackToExistingContent(t *testing.T) {
	m := New()
	now := time.Now()

	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Content:   "Pre-existing content",
		Published: &now,
		Raw:       nil,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !strings.Contains(item.Content, "<p>Pre-existing content</p>") {
		t.Errorf("expected existing content used as description, got %q", item.Content)
	}
	if !strings.Contains(item.Content, "ytimg.com/vi/dQw4w9WgXcQ") {
		t.Errorf("thumbnail still expected, got %q", item.Content)
	}
}

func TestYouTubeModEscapesDescription(t *testing.T) {
	m := New()
	now := time.Now()

	raw := RawFeedItem{
		"description": []RawField{{Txt: `<script>alert(1)</script>`}},
	}
	item := &RawItem{
		GUID:      1,
		Title:     "T",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Published: &now,
		Raw:       raw,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, "<script>") {
		t.Errorf("script tag must be escaped, got %q", item.Content)
	}
	if !strings.Contains(item.Content, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Errorf("expected escaped script, got %q", item.Content)
	}
}

func TestYouTubeModRendersAuthorAboveThumbnail(t *testing.T) {
	m := New()
	now := time.Now()
	raw := RawFeedItem{
		"author": []RawField{{
			Chld: RawFeedItem{
				"name": []RawField{{Txt: "MKBHD"}},
				"uri":  []RawField{{Txt: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ"}},
			},
		}},
	}
	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Published: &now,
		Raw:       raw,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	authorLine := `<p>by <a href="https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ">MKBHD</a></p>`
	if !strings.Contains(item.Content, authorLine) {
		t.Errorf("missing author line, got %q", item.Content)
	}
	// Order matters: author block must precede the thumbnail block so the
	// reader sees "by NAME" before the video card.
	if a, b := strings.Index(item.Content, authorLine), strings.Index(item.Content, "ytimg.com"); a == -1 || a > b {
		t.Errorf("author must precede thumbnail, got %q", item.Content)
	}
}

func TestYouTubeModRendersAuthorPlainTextWhenURIMissing(t *testing.T) {
	m := New()
	now := time.Now()
	raw := RawFeedItem{
		"author": []RawField{{Chld: RawFeedItem{"name": []RawField{{Txt: "Some <Channel> & Co"}}}}},
	}
	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Published: &now,
		Raw:       raw,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	want := `<p>by Some &lt;Channel&gt; &amp; Co</p>`
	if !strings.Contains(item.Content, want) {
		t.Errorf("expected plain author line with escaped name, got %q", item.Content)
	}
	if strings.Contains(item.Content, "<a href=\"\"") {
		t.Errorf("plain-text author must not emit an empty <a> tag, got %q", item.Content)
	}
}

func TestYouTubeModOmitsAuthorWhenAbsent(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{
		GUID:      1,
		Title:     "Vid",
		Link:      "https://youtu.be/dQw4w9WgXcQ",
		Content:   "desc",
		Published: &now,
		Raw:       nil,
	}
	if err := m.Process(context.Background(), "#youtube", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if strings.Contains(item.Content, "<p>by ") {
		t.Errorf("no author should render when Raw is nil, got %q", item.Content)
	}
}

func TestYouTubeModRegistered(t *testing.T) {
	m := New()
	if _, ok := m.processors["#youtube"]; !ok {
		t.Error(`#youtube not registered`)
	}
}
