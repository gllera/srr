package mod

import (
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

// RewriteAttrs covers <a href> (the generic-file path), so a linked file can be
// self-hosted alongside embedded media.
func TestRewriteAttrsCoversAnchorHref(t *testing.T) {
	in := `<a href="#/doc.pdf">file</a>`
	out, err := RewriteAttrs(in, upMarker("assets/zz"))
	if err != nil {
		t.Fatalf("RewriteAttrs: %v", err)
	}
	if !strings.Contains(out, "assets/zz/doc.pdf") {
		t.Errorf("RewriteAttrs did not rewrite anchor href:\n%s", out)
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
