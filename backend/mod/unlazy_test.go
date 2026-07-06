package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runUnlazy processes content through #unlazy and returns the result,
// asserting the immutable fields and the pipeline contract survived.
func runUnlazy(t *testing.T, content string) string {
	t.Helper()
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "T", Content: content, Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#unlazy", item); err != nil {
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

// The canonical lazy pattern: placeholder src, real URL in data-src.
func TestUnlazyDataSrcPromoted(t *testing.T) {
	got := runUnlazy(t,
		`<p><img src="data:image/gif;base64,R0lGOD" data-src="https://x.org/real.jpg" alt="a"></p>`)
	if !strings.Contains(got, `src="https://x.org/real.jpg"`) {
		t.Fatalf("data-src should become src, got %q", got)
	}
	if strings.Contains(got, "base64") {
		t.Errorf("placeholder should be replaced, got %q", got)
	}
}

// data-lazy-src and data-original are equivalent stashes.
func TestUnlazyAlternateDataAttrs(t *testing.T) {
	for _, attr := range []string{"data-lazy-src", "data-original", "data-orig-src"} {
		got := runUnlazy(t, `<img src="" `+attr+`="https://x.org/r.png">`)
		if !strings.Contains(got, `src="https://x.org/r.png"`) {
			t.Errorf("%s should become src, got %q", attr, got)
		}
	}
}

// A boolean-valued lazy attribute must never become a src.
func TestUnlazyNonURLDataValueIgnored(t *testing.T) {
	in := `<img src="https://x.org/a.jpg" data-lazyload="true">`
	if got := runUnlazy(t, in); got != in {
		t.Fatalf("non-URL data value must not promote, got %q", got)
	}
}

// A missing src takes the largest srcset width candidate.
func TestUnlazySrcsetLargestWidth(t *testing.T) {
	got := runUnlazy(t,
		`<img srcset="https://x.org/a-320.jpg 320w, https://x.org/a-1280.jpg 1280w, https://x.org/a-640.jpg 640w">`)
	if !strings.Contains(got, `src="https://x.org/a-1280.jpg"`) {
		t.Fatalf("largest width candidate should win, got %q", got)
	}
}

// Density descriptors rank when no width descriptors exist; data-srcset is
// preferred over srcset.
func TestUnlazySrcsetDensityAndDataSrcset(t *testing.T) {
	got := runUnlazy(t,
		`<img src="https://x.org/spacer.gif" data-srcset="https://x.org/a.jpg 1x, https://x.org/a@2x.jpg 2x" srcset="https://x.org/b.jpg 1x">`)
	if !strings.Contains(got, `src="https://x.org/a@2x.jpg"`) {
		t.Fatalf("highest density from data-srcset should win, got %q", got)
	}
}

// A genuine src is never overridden by srcset.
func TestUnlazyRealSrcKeepsOverSrcset(t *testing.T) {
	in := `<img src="https://x.org/real.jpg" srcset="https://x.org/big.jpg 2000w">`
	if got := runUnlazy(t, in); got != in {
		t.Fatalf("genuine src must not be overridden, got %q", got)
	}
}

// A <noscript> fallback whose image is not otherwise recoverable is
// unwrapped in place.
func TestUnlazyNoscriptUnwrapped(t *testing.T) {
	got := runUnlazy(t,
		`<p><img src="https://x.org/spacer.gif" class="lazyload"></p><noscript><img src="https://x.org/real.jpg" alt="r"></noscript>`)
	if !strings.Contains(got, `<img src="https://x.org/real.jpg" alt="r"/>`) {
		t.Fatalf("noscript image should be unwrapped, got %q", got)
	}
	if strings.Contains(got, "<noscript") {
		t.Errorf("noscript wrapper should be gone, got %q", got)
	}
}

// A <noscript> duplicating the promoted sibling is dropped, not unwrapped.
func TestUnlazyRedundantNoscriptDropped(t *testing.T) {
	got := runUnlazy(t,
		`<img data-src="https://x.org/real.jpg" src="https://x.org/spacer.gif"><noscript><img src="https://x.org/real.jpg"></noscript>`)
	if countSub(got, "<img") != 1 {
		t.Fatalf("want 1 img after redundant noscript drop, got %q", got)
	}
	if strings.Contains(got, "<noscript") {
		t.Errorf("noscript should be removed, got %q", got)
	}
}

// video/audio data-src is promoted like img.
func TestUnlazyVideoDataSrc(t *testing.T) {
	got := runUnlazy(t, `<video data-src="https://x.org/v.mp4" controls></video>`)
	if !strings.Contains(got, `src="https://x.org/v.mp4"`) {
		t.Fatalf("video data-src should become src, got %q", got)
	}
}

// Content without lazy markers returns verbatim — odd quoting preserved.
func TestUnlazyNoOpVerbatim(t *testing.T) {
	in := `<p ><img src='https://x.org/a.jpg'>text &amp; more</p >`
	if got := runUnlazy(t, in); got != in {
		t.Fatalf("no-op must return verbatim, got %q", got)
	}
}

func TestUnlazyRejectsParams(t *testing.T) {
	m := New()
	item := &RawItem{Content: "<p>a</p>"}
	if err := m.Process(context.Background(), "#unlazy foo=bar", item); err == nil {
		t.Fatal("expected unknown-parameter error")
	}
}
