package mod

import (
	"context"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// mediaAttrs lists the element/attribute pairs whose http(s) URL values are
// candidates for self-hosting: image sources and the video player's source +
// poster image.
var mediaAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
}

// RewriteMedia parses content HTML and, for every http(s) URL in <img src>,
// <video src>, <video poster>, downloads it via assets and rewrites the
// attribute to the returned relative store key. On a per-URL Fetch error the
// original URL is kept (graceful degrade). Returns content unchanged when
// assets == nil (preview/tests). Reusable by any built-in module that emits
// media URLs.
func RewriteMedia(ctx context.Context, assets Assets, content string) (string, error) {
	if assets == nil || content == "" {
		return content, nil
	}

	// Parse as a fragment so we don't inject <html>/<head>/<body> wrappers the
	// downstream #sanitize/#minify steps would otherwise have to strip.
	nodes, err := html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
	if err != nil {
		// Unparseable content: leave it untouched rather than fail the item.
		return content, nil
	}

	changed := false
	for _, n := range nodes {
		if rewriteNode(ctx, assets, n) {
			changed = true
		}
	}
	if !changed {
		return content, nil
	}

	var b strings.Builder
	for _, n := range nodes {
		if err := html.Render(&b, n); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

// rewriteNode walks n and its descendants, self-hosting media URLs in place.
// Returns true if any attribute was rewritten.
func rewriteNode(ctx context.Context, assets Assets, n *html.Node) bool {
	changed := false
	if n.Type == html.ElementNode {
		if attrs, ok := mediaAttrs[n.Data]; ok {
			for _, name := range attrs {
				if rewriteAttr(ctx, assets, n, name) {
					changed = true
				}
			}
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if rewriteNode(ctx, assets, c) {
			changed = true
		}
	}
	return changed
}

// rewriteAttr self-hosts the named attribute on n if it carries an http(s)
// URL. A Fetch error leaves the original value untouched.
func rewriteAttr(ctx context.Context, assets Assets, n *html.Node, name string) bool {
	for i := range n.Attr {
		a := &n.Attr[i]
		if a.Key != name {
			continue
		}
		if !isHTTPURL(a.Val) {
			return false
		}
		key, err := assets.Fetch(ctx, a.Val)
		if err != nil {
			return false
		}
		a.Val = key
		return true
	}
	return false
}

func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}
