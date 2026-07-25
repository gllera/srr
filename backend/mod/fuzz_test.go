package mod

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// #sanitize is the writer half of the XSS boundary: whatever it lets through is
// written into IMMUTABLE packs and rendered by every reader forever. The
// frontend's own sanitizer is defence in depth, not a second chance — a stored
// script tag is a stored script tag on any client whose filter has a gap.
//
// So the target does not merely assert "no panic". It asserts the boundary
// itself over arbitrary attacker-shaped markup: no script/style/iframe survives,
// no event-handler attribute survives, no dangerous URL scheme survives, and
// sanitizing twice changes nothing (a non-idempotent filter means the first pass
// left something the second one still had to remove).
// The checks run over the PARSED output, not a regexp on the string: sanitized
// content is mostly text, and text is allowed to contain the literal " onerror="
// or "javascript:" — only an actual attribute or an actual element is a finding.
// (A regexp version of this target reported ` onA=0` in a plain-text body on its
// first fuzzing minute; that is what a false positive costs.)
var fuzzBannedTags = map[string]bool{
	"script": true, "style": true, "iframe": true, "object": true, "embed": true,
	"form": true, "input": true, "button": true, "link": true, "meta": true,
	"base": true, "svg": true, "math": true, "applet": true, "frame": true, "frameset": true,
}

// fuzzURLAttrs are the attributes a browser will DEREFERENCE, so a scheme is
// load-bearing in them and nowhere else.
var fuzzURLAttrs = map[string]bool{
	"href": true, "src": true, "poster": true, "cite": true, "action": true, "formaction": true,
}

var fuzzBadScheme = regexp.MustCompile(`(?i)^\s*(javascript|vbscript|data)\s*:`)

func parseFuzzFragment(t *testing.T, content string) []*html.Node {
	t.Helper()
	nodes, err := html.ParseFragment(strings.NewReader(content),
		&html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body})
	if err != nil {
		t.Fatalf("the sanitizer emitted markup that will not re-parse: %v (%q)", err, content)
	}
	return nodes
}

func walkFuzzNodes(n *html.Node, fn func(*html.Node)) {
	if n.Type == html.ElementNode {
		fn(n)
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		walkFuzzNodes(c, fn)
	}
}

func FuzzSanitize(f *testing.F) {
	f.Add(`<p>hello <b>world</b></p>`)
	f.Add(`<script>alert(1)</script>`)
	f.Add(`<img src=x onerror=alert(1)>`)
	f.Add(`<a href="javascript:alert(1)">x</a>`)
	f.Add(`<video poster="data:text/html,<script>alert(1)</script>" src="https://e.example/v.mp4"></video>`)
	f.Add(`<iframe src="https://evil.example"></iframe>`)
	f.Add(`<svg><animate onbegin=alert(1) attributeName=x dur=1s>`)
	f.Add(`<a href="&#106;avascript:alert(1)">x</a>`)
	f.Add(`<div style="background:url(javascript:alert(1))">x</div>`)
	f.Add(`<audio src="#/tts/a.wav" controls></audio>`)
	f.Add(`<p unclosed`)
	f.Add("")

	m := New()
	ctx := context.Background()

	f.Fuzz(func(t *testing.T, content string) {
		// Feed content is size-capped upstream; keep runs exploring markup
		// shapes rather than length.
		if len(content) > 64<<10 {
			t.Skip()
		}
		item := &RawItem{Content: content}
		if err := m.Process(ctx, "#sanitize", item); err != nil {
			t.Fatalf("#sanitize returned an error on feed content: %v", err)
		}
		out := item.Content
		for _, root := range parseFuzzFragment(t, out) {
			walkFuzzNodes(root, func(n *html.Node) {
				tag := strings.ToLower(n.Data)
				if fuzzBannedTags[tag] {
					t.Fatalf("a banned <%s> survived in %q", tag, out)
				}
				for _, a := range n.Attr {
					name := strings.ToLower(a.Key)
					if strings.HasPrefix(name, "on") {
						t.Fatalf("event-handler attribute %s=%q survived on <%s> in %q", name, a.Val, tag, out)
					}
					if fuzzURLAttrs[name] && fuzzBadScheme.MatchString(a.Val) {
						t.Fatalf("dangerous URL %s=%q survived on <%s> in %q", name, a.Val, tag, out)
					}
				}
			})
		}

		twice := &RawItem{Content: out}
		if err := m.Process(ctx, "#sanitize", twice); err != nil {
			t.Fatalf("#sanitize on its own output: %v", err)
		}
		if twice.Content != out {
			t.Fatalf("#sanitize is not idempotent:\n first: %q\nsecond: %q", out, twice.Content)
		}
	})
}
