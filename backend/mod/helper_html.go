package mod

import (
	"strings"

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
// whitespace collapsed to single spaces. Collection stops once max bytes are
// gathered, bounding the per-article cost on huge content.
func extractText(title, content string, max int) string {
	var b strings.Builder
	appendWords := func(s string) bool {
		for _, f := range strings.Fields(s) {
			if b.Len() >= max {
				return false
			}
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(f)
		}
		return b.Len() < max
	}
	if !appendWords(title) {
		return b.String()
	}
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
