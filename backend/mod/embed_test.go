package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runEmbed processes content through #embed and returns the result,
// asserting the immutable fields and the pipeline contract survived.
func runEmbed(t *testing.T, content string) string {
	t.Helper()
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "T", Content: content, Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#embed", item); err != nil {
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

// A YouTube embed becomes a linked thumbnail plus a text link.
func TestEmbedYouTube(t *testing.T) {
	got := runEmbed(t,
		`<p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe></p>`)
	if strings.Contains(got, "<iframe") {
		t.Fatalf("iframe should be replaced, got %q", got)
	}
	if !strings.Contains(got, `href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"`) {
		t.Errorf("watch link missing, got %q", got)
	}
	if !strings.Contains(got, `src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"`) {
		t.Errorf("thumbnail missing, got %q", got)
	}
	if !strings.Contains(got, "Watch on YouTube") {
		t.Errorf("text link missing, got %q", got)
	}
}

// nocookie host, protocol-relative src, and shorts paths all map.
func TestEmbedYouTubeVariants(t *testing.T) {
	for _, src := range []string{
		"//www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
		"https://www.youtube.com/shorts/dQw4w9WgXcQ",
	} {
		got := runEmbed(t, `<iframe src="`+src+`"></iframe>`)
		if !strings.Contains(got, "watch?v=dQw4w9WgXcQ") {
			t.Errorf("src %q: watch link missing, got %q", src, got)
		}
	}
}

// The iframe title labels the link when present.
func TestEmbedTitleUsedAsLabel(t *testing.T) {
	got := runEmbed(t,
		`<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Never Gonna"></iframe>`)
	if !strings.Contains(got, "▶ Never Gonna") {
		t.Fatalf("iframe title should label the link, got %q", got)
	}
}

// Vimeo has no derivable thumbnail: text link only.
func TestEmbedVimeo(t *testing.T) {
	got := runEmbed(t, `<iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e"></iframe>`)
	if !strings.Contains(got, `href="https://vimeo.com/76979871"`) || strings.Contains(got, "<img") {
		t.Fatalf("want text-only vimeo link, got %q", got)
	}
}

// Dailymotion maps both the classic embed path and the geo player.
func TestEmbedDailymotion(t *testing.T) {
	for _, src := range []string{
		"https://www.dailymotion.com/embed/video/x8abc12",
		"https://geo.dailymotion.com/player.html?video=x8abc12",
	} {
		got := runEmbed(t, `<iframe src="`+src+`"></iframe>`)
		if !strings.Contains(got, `href="https://www.dailymotion.com/video/x8abc12"`) {
			t.Errorf("src %q: link missing, got %q", src, got)
		}
		if !strings.Contains(got, `https://www.dailymotion.com/thumbnail/video/x8abc12`) {
			t.Errorf("src %q: thumbnail missing, got %q", src, got)
		}
	}
}

// A Spotify embed folds back to its open.spotify.com page.
func TestEmbedSpotify(t *testing.T) {
	got := runEmbed(t, `<iframe src="https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"></iframe>`)
	if !strings.Contains(got, `href="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"`) {
		t.Fatalf("spotify link missing, got %q", got)
	}
	if !strings.Contains(got, "Listen on Spotify") {
		t.Errorf("label missing, got %q", got)
	}
}

// Unknown iframes are not converted; the content returns verbatim.
func TestEmbedUnknownIframeVerbatim(t *testing.T) {
	in := `<p>x</p><iframe src="https://ads.example.com/frame"></iframe>`
	if got := runEmbed(t, in); got != in {
		t.Fatalf("unknown iframe must pass through verbatim, got %q", got)
	}
}

// A playlist embed has no single watch URL and is left alone.
func TestEmbedYouTubePlaylistUntouched(t *testing.T) {
	in := `<iframe src="https://www.youtube.com/embed/videoseries?list=PL123"></iframe>`
	if got := runEmbed(t, in); got != in {
		t.Fatalf("playlist embed must pass through, got %q", got)
	}
}

// No iframe at all: verbatim, odd quoting preserved.
func TestEmbedNoOpVerbatim(t *testing.T) {
	in := `<p ><a href='https://x.org'>a &amp; b</a></p >`
	if got := runEmbed(t, in); got != in {
		t.Fatalf("no-op must return verbatim, got %q", got)
	}
}

func TestEmbedRejectsParams(t *testing.T) {
	m := New()
	item := &RawItem{Content: "<p>a</p>"}
	if err := m.Process(context.Background(), "#embed foo=bar", item); err == nil {
		t.Fatal("expected unknown-parameter error")
	}
}
