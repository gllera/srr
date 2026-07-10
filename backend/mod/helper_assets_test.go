package mod

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// upMarker mirrors the real upload-marker policy (the upload step inlined in
// main.Feed.fetch): RewriteAttrs hands fn the marker remainder (the "#" already
// stripped) only for "#"-prefixed values, and the policy maps it under prefix.
func upMarker(prefix string) func(string) (string, bool, error) {
	return func(marker string) (string, bool, error) {
		return prefix + marker, true, nil
	}
}

func TestRewriteAttrsRewritesImgVideoAnchor(t *testing.T) {
	in := `<p><img src="#/ab/photo.jpg"></p>` +
		`<video src="#/clip.mp4"></video>` +
		`<a href="#/doc.pdf">file</a>`
	out, err := RewriteAttrs(in, upMarker("assets/zz"))
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	for _, want := range []string{"assets/zz/ab/photo.jpg", "assets/zz/clip.mp4", "assets/zz/doc.pdf"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, `"#/`) || strings.Contains(out, "=#/") {
		t.Errorf("upload marker survived:\n%s", out)
	}
}

// Non-marker attribute values (no "#" prefix) are passed through untouched and
// never reach fn — the marker convention lives in the walk, so fn only ever sees
// markers.
func TestRewriteAttrsLeavesNonMarkerValues(t *testing.T) {
	calls := 0
	in := `<img src="https://example.com/a.jpg"><img src="assets/aa/1.jpg"><img src="#/m.jpg"><a href="/page">x</a>`
	out, err := RewriteAttrs(in, func(string) (string, bool, error) {
		calls++
		return "", false, nil
	})
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if calls != 1 {
		t.Fatalf("fn called %d times, want 1 (only the #-marker)", calls)
	}
	if !strings.Contains(out, "https://example.com/a.jpg") || !strings.Contains(out, "assets/aa/1.jpg") || !strings.Contains(out, `href="/page"`) {
		t.Errorf("non-marker values altered:\n%s", out)
	}
}

func TestRewriteAttrsKeepsValueOnResolveFalse(t *testing.T) {
	in := `<img src="#missing.jpg">`
	out, err := RewriteAttrs(in, func(string) (string, bool, error) { return "", false, nil })
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if !strings.Contains(out, "#missing.jpg") {
		t.Errorf("unresolved marker should be left in place:\n%s", out)
	}
}

// RewriteAttrs strips the "#" and hands fn the marker remainder, so the caller's
// policy works with the bare path rather than the marker syntax.
func TestRewriteAttrsPassesStrippedMarker(t *testing.T) {
	var got string
	if _, err := RewriteAttrs(`<a href="#/sub/dir/file.pdf">x</a>`, func(marker string) (string, bool, error) {
		got = marker
		return "assets/k", true, nil
	}); err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if got != "/sub/dir/file.pdf" {
		t.Errorf("marker = %q, want %q", got, "/sub/dir/file.pdf")
	}
}

// A non-nil fn error aborts the walk and is surfaced verbatim, with empty
// content (no partial rewrite) — this is what lets the caller (Feed.fetch)
// hard-fail a feed when an asset upload fails.
func TestRewriteAttrsPropagatesFnError(t *testing.T) {
	wantErr := fmt.Errorf("upload boom")
	calls := 0
	out, err := RewriteAttrs(`<img src="#/a.jpg"><img src="#/b.jpg">`, func(string) (string, bool, error) {
		calls++
		return "", false, wantErr
	})
	if err != wantErr {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
	if out != "" {
		t.Errorf("content on fn error = %q, want empty", out)
	}
	if calls != 1 {
		t.Errorf("walk did not stop on first error: fn called %d times", calls)
	}
}

func TestCacheDirContextRoundTrips(t *testing.T) {
	ctx := WithCacheDir(context.Background(), "/tmp/run-cache")
	if got := cacheDirFromContext(ctx); got != "/tmp/run-cache" {
		t.Errorf("cacheDirFromContext = %q, want %q", got, "/tmp/run-cache")
	}
	if got := cacheDirFromContext(context.Background()); got != "" {
		t.Errorf("absent cache dir = %q, want empty string", got)
	}
}

// walkAssetAttrs visits EVERY listed attribute (not just "#"-markers); the
// callback decides. Here it uppercases each img/video/audio src to prove the
// generic walk + selective rewrite + no-op-preserves-original behavior.
func TestWalkAssetAttrsRewritesSelected(t *testing.T) {
	in := `<img src="a"><video src="b"></video><audio src="c"></audio><a href="d">x</a>`
	out, err := walkAssetAttrs(in, mediaAttrs, func(val string) (string, bool, error) {
		return strings.ToUpper(val), true, nil
	})
	if err != nil {
		t.Fatalf("walkAssetAttrs: %v", err)
	}
	for _, want := range []string{`src="A"`, `src="B"`, `src="C"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
	// mediaAttrs does NOT include <a href>, so the link is untouched.
	if !strings.Contains(out, `href="d"`) {
		t.Errorf("anchor href should be untouched: %s", out)
	}
}

func TestWalkAssetAttrsNoMatchReturnsOriginal(t *testing.T) {
	in := `<p>no media here</p>`
	out, err := walkAssetAttrs(in, mediaAttrs, func(_ string) (string, bool, error) {
		t.Fatal("fn must not be called when no listed attribute is present")
		return "", false, nil
	})
	if err != nil || out != in {
		t.Errorf("got (%q, %v), want original unchanged", out, err)
	}
}

// assetAttrs now covers <audio src>, so the upload step rewrites an audio marker.
func TestRewriteAttrsCoversAudio(t *testing.T) {
	out, err := RewriteAttrs(`<audio src="#/clip.mp3"></audio>`, upMarker("assets/zz"))
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if !strings.Contains(out, "assets/zz/clip.mp3") {
		t.Errorf("audio marker not rewritten: %s", out)
	}
}

func TestHasAssetMarkers(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"img marker", `<img src="#/a.jpg">`, true},
		{"anchor marker", `<a href="#/doc.pdf">x</a>`, true},
		{"single-quoted marker", `<img src='#/a.jpg'>`, true},
		{"bare fragment anchor", `<a href="#section">x</a>`, true}, // shape matches; fn declines later
		{"plain hash text", `<p>cost is #1 today</p>`, false},
		{"no hash at all", `<p><img src="https://x/a.jpg"></p>`, false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := HasAssetMarkers(c.in); got != c.want {
				t.Errorf("HasAssetMarkers(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
