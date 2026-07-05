package mod

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runDedupMedia processes content through #dedupmedia and returns the result,
// asserting the immutable fields and the pipeline contract survived.
func runDedupMedia(t *testing.T, content string) string {
	t.Helper()
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 7, Title: "T", Content: content, Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#dedupmedia", item); err != nil {
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

func countSub(s, sub string) int { return strings.Count(s, sub) }

// The motivating case (finofilipino.org): a WordPress plugin prepends a bare
// featured image the body repeats with alt text and dimensions. The rich body
// copy survives; the bare lead and its emptied wrapper go.
func TestDedupMediaLeadDuplicateKeepsRichCopy(t *testing.T) {
	got := runDedupMedia(t,
		`<p><img src="https://x.org/up/a.jpg"></p><p>cap</p>`+
			`<blockquote><img src="https://x.org/up/a.jpg" alt="t" width="383" height="680"><p>[link]</p></blockquote>`)
	if countSub(got, "<img") != 1 {
		t.Fatalf("want 1 img, got %q", got)
	}
	if !strings.Contains(got, `alt="t"`) {
		t.Errorf("rich copy should survive, got %q", got)
	}
	if !strings.HasPrefix(got, "<p>cap") {
		t.Errorf("lead image wrapper should be pruned, got %q", got)
	}
}

// A resized WordPress variant (-150x150) is the same picture; the canonical
// full-size file wins even when the variant carries alt text.
func TestDedupMediaSizeVariantCanonicalWins(t *testing.T) {
	got := runDedupMedia(t,
		`<p><img src="https://x.org/up/b.jpg"></p><p><img src="https://x.org/up/b-150x150.jpg" alt="thumb"></p>`)
	if countSub(got, "<img") != 1 || strings.Contains(got, "150x150") {
		t.Fatalf("canonical file should win over sized variant, got %q", got)
	}
}

// A wp.com Photon proxy URL is the same file as the direct one.
func TestDedupMediaPhotonProxy(t *testing.T) {
	got := runDedupMedia(t,
		`<p><img src="https://i0.wp.com/x.org/up/c.jpg?resize=300,200"></p><p>t</p><p><img src="https://x.org/up/c.jpg" alt="z"></p>`)
	if countSub(got, "<img") != 1 || strings.Contains(got, "i0.wp.com") {
		t.Fatalf("proxied duplicate should collapse to the canonical copy, got %q", got)
	}
}

func TestDedupMediaQueryStringVariant(t *testing.T) {
	got := runDedupMedia(t,
		`<p><img src="https://x.org/d.jpg?w=600"></p><p>t</p><p><img src="https://x.org/d.jpg" alt="q"></p>`)
	if countSub(got, "<img") != 1 {
		t.Fatalf("query-string duplicate should collapse, got %q", got)
	}
}

// Distinct images are untouched — and the content comes back VERBATIM (no
// re-render), so quoting/whitespace survive a no-op pass.
func TestDedupMediaUniqueImagesVerbatim(t *testing.T) {
	in := `<p><img src='https://x.org/e1.jpg'></p>` + "\n" + `<p><img src=https://x.org/e2.jpg></p>`
	if got := runDedupMedia(t, in); got != in {
		t.Fatalf("unique images must be a verbatim no-op, got %q", got)
	}
}

func TestDedupMediaThreeCopiesKeepOne(t *testing.T) {
	got := runDedupMedia(t,
		`<img src="https://x.org/f.jpg"><img src="https://x.org/f.jpg" alt="k"><img src="https://x.org/f.jpg">`)
	if countSub(got, "<img") != 1 || !strings.Contains(got, `alt="k"`) {
		t.Fatalf("want only the alt'd copy, got %q", got)
	}
}

// Removing a duplicate prunes wrappers left saying nothing (<a> around it,
// then the emptied <p>), but never a wrapper that still has text.
func TestDedupMediaPrunesEmptyWrappers(t *testing.T) {
	got := runDedupMedia(t,
		`<p><a href="https://x.org/g"><img src="https://x.org/g.jpg"></a></p><p>txt <img src="https://x.org/g.jpg" alt="g"></p>`)
	if countSub(got, "<img") != 1 || strings.Contains(got, "<a") || countSub(got, "<p") != 1 {
		t.Fatalf("wrappers should prune with the removed duplicate, got %q", got)
	}
}

func TestDedupMediaVideoDuplicate(t *testing.T) {
	got := runDedupMedia(t,
		`<video src="https://x.org/v.mp4"></video><p>t</p>`+
			`<video src="https://x.org/v.mp4" controls poster="https://x.org/p.jpg"></video>`)
	if countSub(got, "<video") != 1 || !strings.Contains(got, "controls") {
		t.Fatalf("want the controls+poster copy only, got %q", got)
	}
}

// The same file behind different element types is not a duplicate (an <img>
// and a <video> render differently even off one URL).
func TestDedupMediaTagsNotMerged(t *testing.T) {
	in := `<img src="https://x.org/h.jpg"><video src="https://x.org/h.jpg"></video>`
	if got := runDedupMedia(t, in); got != in {
		t.Fatalf("cross-tag same-URL must be a no-op, got %q", got)
	}
}

func TestDedupMediaNoMediaVerbatim(t *testing.T) {
	for _, in := range []string{"<p>hello</p>", ""} {
		if got := runDedupMedia(t, in); got != in {
			t.Fatalf("no-media content must come back verbatim, got %q", got)
		}
	}
}

// Images functioning as text or layout repeat on purpose: WordPress emoji
// (<img class="wp-smiley">, s.w.org URLs, emoji alt), small icons, and
// spacer/placeholder gifs never join a dedup group.
func TestDedupMediaGlyphsExempt(t *testing.T) {
	cases := map[string]string{
		"wp-smiley": `<p>go <img src="https://s.w.org/images/core/emoji/15.1.0/72x72/27a1.png" alt="➡" class="wp-smiley" style="height: 1em; max-height: 1em;"> A</p>` +
			`<p>go <img src="https://s.w.org/images/core/emoji/15.1.0/72x72/27a1.png" alt="➡" class="wp-smiley" style="height: 1em; max-height: 1em;"> B</p>`,
		"bare s.w.org (post-sanitize form)": `<p><img src="https://s.w.org/images/core/emoji/15.1.0/72x72/27a1.png"> x</p>` +
			`<p><img src="https://s.w.org/images/core/emoji/15.1.0/72x72/27a1.png"> y</p>`,
		"twemoji class + emoji alt": `<p><img class="emoji" alt="🔥" src="https://cdn.example/72/1f525.png"> a` +
			` <img class="emoji" alt="🔥" src="https://cdn.example/72/1f525.png"> b</p>`,
		"small icons":       `<img src="https://x.org/star.png" width="48" height="48"><img src="https://x.org/star.png" width="48" height="48">`,
		"blank.gif spacers": `<img height="80" src="https://x.org/themes/t/images/default/blank.gif"><p>a</p><img height="80" src="https://x.org/themes/t/images/default/blank.gif">`,
	}
	for name, in := range cases {
		if got := runDedupMedia(t, in); got != in {
			t.Errorf("%s: glyphs must never dedup, got %q", name, got)
		}
	}
}

// The glyph exemption must not shadow a real duplicate in the same article.
func TestDedupMediaMixedGlyphAndContentDup(t *testing.T) {
	emoji := `<img class="wp-smiley" style="height:1em" src="https://s.w.org/images/core/emoji/15.1.0/72x72/27a1.png" alt="➡">`
	got := runDedupMedia(t,
		`<p><img src="https://x.org/big.jpg"></p><p>`+emoji+` deal `+emoji+`</p>`+
			`<p><img src="https://x.org/big.jpg" alt="d" width="800" height="600"></p>`)
	if countSub(got, "big.jpg") != 1 {
		t.Errorf("content duplicate should collapse, got %q", got)
	}
	if countSub(got, "emoji/15.1.0") != 2 {
		t.Errorf("repeated emoji must survive, got %q", got)
	}
}

// #dedupmedia takes no options; a stray parameter is a config error.
func TestDedupMediaRejectsParams(t *testing.T) {
	m := New()
	now := time.Now()
	item := &RawItem{GUID: 1, Title: "T", Content: "<p>a</p>", Link: "http://e.com", Published: &now}
	if err := m.Process(context.Background(), "#dedupmedia x=1", item); err == nil {
		t.Fatal("expected unknown-parameter error")
	}
}
