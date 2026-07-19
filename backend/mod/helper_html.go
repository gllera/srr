package mod

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// parseBodyHTML parses an article-content fragment into one synthetic <body>
// node so callers can walk, remove, and reparent top-level nodes uniformly.
// Returns nil when the fragment does not parse — the HTML-walking modules
// treat that as "pass the content through untouched".
func parseBodyHTML(content string) *html.Node {
	nodes, err := html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
	if err != nil {
		return nil
	}
	body := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	for _, n := range nodes {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
		body.AppendChild(n)
	}
	return body
}

// renderBodyHTML renders body's children back to an HTML string. ok=false on
// a render failure — callers return their original content then.
func renderBodyHTML(body *html.Node) (string, bool) {
	var b strings.Builder
	for c := body.FirstChild; c != nil; c = c.NextSibling {
		if err := html.Render(&b, c); err != nil {
			return "", false
		}
	}
	return b.String(), true
}

// setNodeAttr sets (or appends) an attribute on an element node.
func setNodeAttr(n *html.Node, key, val string) {
	for i := range n.Attr {
		if n.Attr[i].Key == key {
			n.Attr[i].Val = val
			return
		}
	}
	n.Attr = append(n.Attr, html.Attribute{Key: key, Val: val})
}

// extractText returns the plain text of title + content for language
// detection: content is parsed as HTML and only its text nodes contribute
// (script/style subtrees excluded — a mod may run before #sanitize), all
// whitespace collapsed to single spaces. The result is a HARD max bytes: a
// single oversized token is truncated (on a rune boundary) rather than
// written whole, so the per-article cost stays bounded even on content with
// no whitespace at all — scripts like Japanese or Chinese are one
// strings.Fields token per paragraph, so truncating rather than dropping is
// what keeps them detectable.
func extractText(title, content string, max int) string {
	var b strings.Builder
	appendWords := func(s string) bool {
		for _, f := range strings.Fields(s) {
			room := max - b.Len()
			if b.Len() > 0 {
				room-- // the separating space
			}
			if room <= 0 {
				return false
			}
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			if len(f) > room {
				b.WriteString(truncRunes(f, room))
				return false
			}
			b.WriteString(f)
		}
		return b.Len() < max
	}
	if !appendWords(title) {
		return b.String()
	}
	// The WHOLE document is parsed, deliberately. Truncating the raw HTML first
	// would bound the parse cost, but a byte cut on markup is not a cut on
	// text: text-sparse markup (a big inline data: URI, a JSON-LD blob, a run
	// of empty tags) pushes the article's real text past any byte budget, and
	// then the extract either comes back empty or — worse — contains only a
	// short foreign boilerplate line that survived the cut and gets classified
	// confidently. A wrong-but-confident stamp is the one outcome this design
	// must not produce: `#filter keep_lang` would drop the article, and its
	// GUID is already in the dedup boundary, so it is gone for good. Parsing
	// is linear and the per-article cost is bounded by the article itself.
	body := parseBodyHTML(content)
	if body == nil {
		return b.String()
	}
	var walk func(*html.Node) bool
	walk = func(n *html.Node) bool {
		if n.Type == html.ElementNode && (n.DataAtom == atom.Script || n.DataAtom == atom.Style) {
			return true // skip subtree, keep walking siblings
		}
		if n.Type == html.TextNode && !appendWords(n.Data) {
			return false
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !walk(c) {
				return false
			}
		}
		return true
	}
	walk(body)
	return b.String()
}

// truncRunes returns the longest prefix of s that fits in n bytes without
// splitting a rune — a partial UTF-8 sequence would be garbage to the
// language detector. A non-positive n yields "" rather than panicking: the
// one caller guards room > 0, but a helper that slices its argument must not
// be a landmine for the next one.
func truncRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
