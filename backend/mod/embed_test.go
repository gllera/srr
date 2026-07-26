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

// TikTok links the normalized player page — the embed URL carries no author,
// so no watch page is derivable — from all three player paths.
func TestEmbedTikTok(t *testing.T) {
	for _, src := range []string{
		"https://www.tiktok.com/embed/v2/7112233445566778899",
		"https://www.tiktok.com/embed/7112233445566778899",
		"https://m.tiktok.com/player/v1/7112233445566778899",
	} {
		got := runEmbed(t, `<iframe src="`+src+`"></iframe>`)
		if !strings.Contains(got, `href="https://www.tiktok.com/embed/v2/7112233445566778899"`) {
			t.Errorf("src %q: player link missing, got %q", src, got)
		}
		if !strings.Contains(got, "Watch on TikTok") || strings.Contains(got, "<img") {
			t.Errorf("src %q: want text-only tiktok link, got %q", src, got)
		}
	}
}

// Twitch maps VODs (bare and v-prefixed ids), live channels and clips.
func TestEmbedTwitch(t *testing.T) {
	for _, tc := range []struct{ src, want string }{
		{"https://player.twitch.tv/?video=1122334455&amp;parent=e.com", "https://www.twitch.tv/videos/1122334455"},
		{"https://player.twitch.tv/?video=v1122334455", "https://www.twitch.tv/videos/1122334455"},
		{"//player.twitch.tv/?channel=some_streamer", "https://www.twitch.tv/some_streamer"},
		{"https://clips.twitch.tv/embed?clip=TenaciousBlithePorcupine", "https://clips.twitch.tv/TenaciousBlithePorcupine"},
	} {
		got := runEmbed(t, `<iframe src="`+tc.src+`"></iframe>`)
		if !strings.Contains(got, `href="`+tc.want+`"`) {
			t.Errorf("src %q: want link %q, got %q", tc.src, tc.want, got)
		}
		if !strings.Contains(got, "Watch on Twitch") {
			t.Errorf("src %q: label missing, got %q", tc.src, got)
		}
	}
}

// The SoundCloud widget's public page rides its url= param.
func TestEmbedSoundCloud(t *testing.T) {
	got := runEmbed(t,
		`<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack&amp;color=%23ff5500"></iframe>`)
	if !strings.Contains(got, `href="https://soundcloud.com/artist/track"`) {
		t.Fatalf("track link missing, got %q", got)
	}
	if !strings.Contains(got, "Listen on SoundCloud") || strings.Contains(got, "<img") {
		t.Errorf("want text-only soundcloud link, got %q", got)
	}
}

// Streamable's three player paths fold to the id at the root.
func TestEmbedStreamable(t *testing.T) {
	for _, src := range []string{
		"https://streamable.com/e/moo9v2",
		"https://streamable.com/o/moo9v2",
		"//streamable.com/s/moo9v2",
	} {
		got := runEmbed(t, `<iframe src="`+src+`"></iframe>`)
		if !strings.Contains(got, `href="https://streamable.com/moo9v2"`) {
			t.Errorf("src %q: link missing, got %q", src, got)
		}
		if !strings.Contains(got, "Watch on Streamable") {
			t.Errorf("src %q: label missing, got %q", src, got)
		}
	}
}

// Bandcamp links the normalized player page for the album or track id its
// key=value path carries — no artist page is derivable from it.
func TestEmbedBandcamp(t *testing.T) {
	for _, tc := range []struct{ src, want string }{
		{"https://bandcamp.com/EmbeddedPlayer/album=123456/size=large/tracklist=false/",
			"https://bandcamp.com/EmbeddedPlayer/album=123456/"},
		{"https://bandcamp.com/EmbeddedPlayer/track=987654/size=small/",
			"https://bandcamp.com/EmbeddedPlayer/track=987654/"},
	} {
		got := runEmbed(t, `<iframe src="`+tc.src+`"></iframe>`)
		if !strings.Contains(got, `href="`+tc.want+`"`) {
			t.Errorf("src %q: want link %q, got %q", tc.src, tc.want, got)
		}
		if !strings.Contains(got, "Listen on Bandcamp") || strings.Contains(got, "<img") {
			t.Errorf("src %q: want text-only bandcamp link, got %q", tc.src, got)
		}
	}
}

// Near-misses on a known provider host stay unrecognized: no derivable
// target must ever be guessed, and the iframe is left for #sanitize.
func TestEmbedUnrecognizedTargetsUntouched(t *testing.T) {
	for _, src := range []string{
		// A collection player has no single target.
		"https://player.twitch.tv/?collection=xO4Ao1YabcdEfg",
		// A live channel name outside the Twitch login grammar.
		"https://player.twitch.tv/?channel=no",
		// An API track ref needs an API call to resolve to a page.
		"https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/1234",
		// A url= param pointing somewhere else entirely.
		"https://w.soundcloud.com/player/?url=https%3A//evil.example.com/x",
		// Non-numeric provider ids.
		"https://www.tiktok.com/embed/v2/not-an-id",
		"https://bandcamp.com/EmbeddedPlayer/album=abc/size=large/",
		// An unknown path on a known host.
		"https://streamable.com/x/moo9v2",
	} {
		in := `<p>x</p><iframe src="` + src + `"></iframe>`
		got := runEmbed(t, in)
		if got != in {
			t.Errorf("src %q must pass through verbatim, got %q", src, got)
		}
		if !strings.Contains(got, "<iframe") {
			t.Errorf("src %q: iframe must be left in the DOM, got %q", src, got)
		}
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
