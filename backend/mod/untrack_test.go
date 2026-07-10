package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runUntrack processes content through #untrack and returns the result,
// asserting the immutable fields and the pipeline contract survived.
func runUntrack(t *testing.T, content string) string {
	t.Helper()
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "T", Content: content, Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#untrack", item); err != nil {
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

// utm_* parameters are dropped; other parameters keep order and encoding.
func TestUntrackUTMStripped(t *testing.T) {
	got := runUntrack(t,
		`<a href="https://x.org/p?id=3&amp;utm_source=rss&amp;utm_medium=feed&amp;page=2">l</a>`)
	if !strings.Contains(got, `href="https://x.org/p?id=3&amp;page=2"`) {
		t.Fatalf("utm params should be stripped, others kept in order, got %q", got)
	}
}

// A query reduced to nothing loses its "?"; fragments survive.
func TestUntrackFullQueryRemoved(t *testing.T) {
	got := runUntrack(t, `<a href="https://x.org/p?fbclid=abc#frag">l</a>`)
	if !strings.Contains(got, `href="https://x.org/p#frag"`) {
		t.Fatalf("emptied query should drop the ?, keep fragment, got %q", got)
	}
}

// A URL with NO query whose fragment itself contains "?" must be left intact —
// the "?" belongs to the fragment (a hash router route), not a query, so nothing
// is stripped.
func TestUntrackQuerylessFragmentWithQuestionMarkKept(t *testing.T) {
	got := runUntrack(t, `<a href="https://x.org/a#route?fbclid=123">l</a>`)
	if !strings.Contains(got, `href="https://x.org/a#route?fbclid=123"`) {
		t.Fatalf("fragment containing ? must be preserved verbatim, got %q", got)
	}
}

// Media srcs are cleaned like anchors.
func TestUntrackImgSrcParams(t *testing.T) {
	got := runUntrack(t, `<img src="https://x.org/a.jpg?w=640&amp;mc_eid=xyz">`)
	if !strings.Contains(got, `src="https://x.org/a.jpg?w=640"`) {
		t.Fatalf("img tracking params should be stripped, got %q", got)
	}
}

// Non-http(s) URLs are never touched — relative asset keys included.
func TestUntrackNonHTTPUntouched(t *testing.T) {
	in := `<a href="mailto:a@b.c?subject=utm_source">m</a><img src="assets/ab/cd.webp">`
	if got := runUntrack(t, in); got != in {
		t.Fatalf("non-http URLs must pass through, got %q", got)
	}
}

// A 1x1 beacon is removed and its emptied wrapper pruned.
func TestUntrackPixelRemoved(t *testing.T) {
	got := runUntrack(t,
		`<p>text</p><p><img src="https://x.org/open.gif" width="1" height="1"></p>`)
	if strings.Contains(got, "<img") || strings.Contains(got, "open.gif") {
		t.Fatalf("1x1 pixel should be removed, got %q", got)
	}
	if got != "<p>text</p>" {
		t.Errorf("emptied wrapper should be pruned, got %q", got)
	}
}

// Known beacon endpoints are removed regardless of declared size.
func TestUntrackBeaconEndpointRemoved(t *testing.T) {
	for _, src := range []string{
		"https://feeds.feedburner.com/~r/SomeFeed/~4/abcdef",
		"https://xyz.list-manage.com/track/open.php?u=1&id=2",
		"https://pixel.wp.com/b.gif?host=x.org",
	} {
		got := runUntrack(t, `<p>t</p><img src="`+src+`">`)
		if strings.Contains(got, "<img") {
			t.Errorf("beacon %q should be removed, got %q", src, got)
		}
	}
}

// Small-but-real images stay: only <=2px on both sides classifies as beacon.
func TestUntrackSmallIconKept(t *testing.T) {
	in := `<img src="https://x.org/icon.png" width="16" height="16">`
	if got := runUntrack(t, in); got != in {
		t.Fatalf("16px icon must survive, got %q", got)
	}
}

// A lazy placeholder declaring 1x1 is not a beacon while its data-src holds
// the real image.
func TestUntrackLazyPlaceholderKept(t *testing.T) {
	in := `<img src="https://x.org/sp.gif" width="1" height="1" data-src="https://x.org/real.jpg">`
	if got := runUntrack(t, in); got != in {
		t.Fatalf("lazy placeholder must survive for #unlazy, got %q", got)
	}
}

// The trailing WordPress syndication footer is removed.
func TestUntrackWPTrailerRemoved(t *testing.T) {
	got := runUntrack(t,
		`<p>body</p><p>The post <a href="https://x.org/p">Title</a> appeared first on <a href="https://x.org">X</a>.</p>`)
	if got != "<p>body</p>" {
		t.Fatalf("WP trailer should be removed, got %q", got)
	}
}

// The phrase mid-article is not a trailer.
func TestUntrackWPTrailerMidArticleKept(t *testing.T) {
	in := `<p>The post X appeared first on Y.</p><p>more body</p>`
	if got := runUntrack(t, in); got != in {
		t.Fatalf("mid-article phrase must survive, got %q", got)
	}
}

// Clean content returns verbatim — odd quoting preserved.
func TestUntrackNoOpVerbatim(t *testing.T) {
	in := `<p ><a href='https://x.org/p?id=3'>a &amp; b</a></p >`
	if got := runUntrack(t, in); got != in {
		t.Fatalf("no-op must return verbatim, got %q", got)
	}
}

func TestUntrackRejectsParams(t *testing.T) {
	m := New()
	item := &RawItem{Content: "<p>a</p>"}
	if err := m.Process(context.Background(), "#untrack foo=bar", item); err == nil {
		t.Fatal("expected unknown-parameter error")
	}
}
