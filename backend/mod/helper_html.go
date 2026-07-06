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
