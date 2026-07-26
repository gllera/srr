package main

import (
	"fmt"
	"strings"
	"testing"

	"srr/mod"
)

// What the one-parse content session (FET11, mod/session.go) is worth, and the
// guard against giving it back. Every HTML-walking step used to own a full
// parse/render round-trip of the article; they now share one.
//
// Measured 2026-07-26 on the development box (i9-14900K), same fixture, same
// pipes, before vs after:
//
//	DOM pipe    per-mod parse:  2.75 ms/op  1,086 KB/op  22,097 allocs/op
//	            one-parse:      1.91 ms/op    591 KB/op  17,223 allocs/op  (-31% time, -46% bytes)
//	string pipe per-mod parse:  1.64 ms/op    528 KB/op  16,676 allocs/op
//	            one-parse:      1.53 ms/op    470 KB/op  15,874 allocs/op  (-7% time, -11% bytes)
//
// The string-only pipe wins because the always-on absolutizer and the language
// stamp share the session's DOM instead of parsing the content twice between
// them — the session pays off before the pipeline has a single DOM step in it.

// benchPipeDOM is the recommended rich pipe: the DOM steps clustered, then the
// string steps that close it out.
var benchPipeDOM = []string{"#enclosure", "#unlazy", "#untrack", "#dedupmedia", "#embed", "#sanitize", "#minify"}

// benchPipeString exercises the no-DOM-steps path — where the session must not
// cost anything it does not save.
var benchPipeString = []string{"#sanitize", "#minify"}

// benchContent builds a realistic article: prose paragraphs, lazy-loaded
// images, tracked links, an embed, and a WordPress trailer — one case for
// every step in benchPipeDOM, at a size (~11 KB) typical of a full-text feed.
func benchContent() string {
	var b strings.Builder
	b.WriteString(`<p class="lead">Intro paragraph with <a href="https://ex.com/a?utm_source=x&amp;id=1">a link</a>.</p>`)
	for i := range 40 {
		b.WriteString(`<p>Some ordinary article text that a reader would actually read, repeated to make the document realistic in size and node count.</p>`)
		fmt.Fprintf(&b, `<figure><img src="https://ex.com/spacer.gif" data-src="https://ex.com/pic%d.jpg"></figure>`, i)
		fmt.Fprintf(&b, `<p><a href="https://ex.com/p/%d?utm_campaign=z&amp;ok=1">more</a></p>`, i)
	}
	b.WriteString(`<p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></p>`)
	b.WriteString(`<p>The post X appeared first on Y.</p>`)
	return b.String()
}

func benchProcessItem(b *testing.B, pipe []string) {
	b.Helper()
	content := benchContent()
	m := mod.New()
	raw := mod.RawFeedItem{"enclosure": {{Attr: map[string]string{
		"url": "https://ex.com/ep.mp3", "type": "audio/mpeg"}}}}
	b.SetBytes(int64(len(content)))
	b.ReportAllocs()
	for b.Loop() {
		item := &mod.RawItem{GUID: 1, Title: "A realistic article title",
			Content: content, Link: "https://ex.com/post/1", Raw: raw}
		if err := processItem(ctx, m, pipe, item, ""); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkProcessItemDOMPipe(b *testing.B)    { benchProcessItem(b, benchPipeDOM) }
func BenchmarkProcessItemStringPipe(b *testing.B) { benchProcessItem(b, benchPipeString) }
