package mod

import (
	"context"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// mediaAttrs lists the element/attribute pairs RewriteMedia self-hosts by
// downloading an embedded http(s) URL. Links (<a href>) are deliberately
// excluded — a link target is navigation, not an embedded asset to fetch.
var mediaAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
}

// assetAttrs lists every element/attribute pair whose value may reference a
// self-hostable file: the embedded-media set plus <a href>, so a linked file
// (PDF, doc, …) can be hosted alongside images and video. Used by RewriteAttrs
// (the end-of-pipeline upload step). Every entry must be one the sanitizer
// keeps (mod/sanitize.go) or the rewritten key would be stripped before
// storage — img/video src and a href survive as relative URLs; <video poster>
// is constrained to ^(https?://|assets/) and only round-trips a rewritten
// assets/ key, not an arbitrary upload marker.
var assetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"a":     {"href"},
}

// rewriteFragment parses content as an HTML fragment and applies fn to every
// value of the given element/attribute pairs (e.g. <img src>, <a href>). fn
// returns (newValue, true) to replace the value or (_, false) to leave it
// untouched. Unparseable content and a no-op pass both return the original
// string verbatim (no re-render), so quoting/whitespace survives when nothing
// changed. Shared by RewriteMedia (mediaAttrs) and RewriteAttrs (assetAttrs).
func rewriteFragment(content string, attrs map[string][]string, fn func(val string) (string, bool, error)) (string, error) {
	if content == "" {
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
		c, err := applyAttrs(n, attrs, fn)
		if err != nil {
			return "", err
		}
		if c {
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

// applyAttrs walks n and its descendants, applying fn to each value of attrs in
// place. Returns true if any value was rewritten, or the first error fn returns
// (which stops the walk).
func applyAttrs(n *html.Node, attrs map[string][]string, fn func(val string) (string, bool, error)) (bool, error) {
	changed := false
	if n.Type == html.ElementNode {
		if names, ok := attrs[n.Data]; ok {
			for _, name := range names {
				for i := range n.Attr {
					if n.Attr[i].Key != name {
						continue
					}
					nv, ok, err := fn(n.Attr[i].Val)
					if err != nil {
						return false, err
					}
					if ok {
						n.Attr[i].Val = nv
						changed = true
					}
				}
			}
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		cc, err := applyAttrs(c, attrs, fn)
		if err != nil {
			return false, err
		}
		if cc {
			changed = true
		}
	}
	return changed, nil
}

// RewriteMedia parses content HTML and, for every http(s) URL in <img src>,
// <video src>, <video poster>, downloads it via assets and rewrites the
// attribute to the returned relative store key. On a per-URL Fetch error the
// original URL is kept (graceful degrade). Returns content unchanged when
// assets == nil (preview/tests). Reusable by any built-in module that emits
// media URLs.
func RewriteMedia(ctx context.Context, assets Assets, content string) (string, error) {
	if assets == nil {
		return content, nil
	}
	return rewriteFragment(content, mediaAttrs, func(val string) (string, bool, error) {
		if !isHTTPURL(val) {
			return "", false, nil
		}
		key, err := assets.Fetch(ctx, val)
		if err != nil {
			// Graceful degrade: keep the original URL on a per-URL Fetch error.
			return "", false, nil
		}
		return key, true, nil
	})
}

// RewriteAttrs walks every self-hostable attribute value in content (img/video
// src/poster, a href — see assetAttrs) and applies fn, which returns
// (newValue, true, nil) to replace the value, (_, false, nil) to leave it
// untouched, or a non-nil error to abort the walk and surface it to the caller.
// It is the generic attribute walk behind the end-of-pipeline asset-upload step
// (inlined in main.Feed.fetch): the caller's fn owns the upload policy — which
// values are upload markers, how the referenced files are stored, and which
// failures are fatal — keeping that policy out of this package. Unparseable
// content is returned unchanged with a nil error; a fn or render error is
// returned alongside an empty string.
func RewriteAttrs(content string, fn func(val string) (string, bool, error)) (string, error) {
	return rewriteFragment(content, assetAttrs, fn)
}

func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}
