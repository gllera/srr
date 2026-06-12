package mod

import (
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

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

// rewriteFragment parses content as an HTML fragment and rewrites the
// "#"-prefixed upload markers among the given element/attribute pairs (e.g. <img
// src>, <a href>). For each marker it calls fn with the remainder (the "#"
// stripped); fn returns (newValue, true) to replace the whole attribute value or
// (_, false) to leave the original marker untouched. Non-marker values are left
// untouched without reaching fn. Unparseable content and a no-op pass both return
// the original string verbatim (no re-render), so quoting/whitespace survives
// when nothing changed. Backs RewriteAttrs (assetAttrs).
func rewriteFragment(content string, attrs map[string][]string, fn func(marker string) (string, bool, error)) (string, error) {
	// Markers are "#"-prefixed, so content with no "#" can hold none (this also
	// covers empty content): skip the parse+walk entirely. The common case —
	// built-in #rss feeds never emit markers — costs only this substring scan.
	if !strings.Contains(content, "#") {
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

// applyAttrs walks n and its descendants, rewriting the "#"-prefixed upload
// markers among the values of attrs in place: for each marker it calls fn with
// the remainder (the "#" stripped) and replaces the whole value when fn returns
// ok. Non-marker values are skipped without reaching fn. Returns true if any
// value was rewritten, or the first error fn returns (which stops the walk).
func applyAttrs(n *html.Node, attrs map[string][]string, fn func(marker string) (string, bool, error)) (bool, error) {
	changed := false
	if n.Type == html.ElementNode {
		if names, ok := attrs[n.Data]; ok {
			for _, name := range names {
				for i := range n.Attr {
					if n.Attr[i].Key != name {
						continue
					}
					// Only "#"-prefixed values are upload markers; hand fn the remainder.
					val := n.Attr[i].Val
					if !strings.HasPrefix(val, "#") {
						continue
					}
					nv, ok, err := fn(strings.TrimPrefix(val, "#"))
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

// RewriteAttrs walks every self-hostable attribute value in content (img/video
// src/poster, a href — see assetAttrs) and rewrites its "#"-prefixed upload
// markers: for each marker it calls fn with the remainder (the "#" already
// stripped), which returns (newValue, true, nil) to replace the whole value,
// (_, false, nil) to leave the marker untouched, or a non-nil error to abort the
// walk and surface it to the caller. Non-marker values are passed through without
// reaching fn. It is the asset-upload walk behind the end-of-pipeline step
// inlined in main.Feed.fetch: fn owns the upload policy — how the referenced
// files are stored and which failures are fatal — while the marker convention
// (the "#" prefix) lives here. Unparseable content is returned unchanged with a
// nil error; a fn or render error is returned alongside an empty string.
func RewriteAttrs(content string, fn func(marker string) (string, bool, error)) (string, error) {
	return rewriteFragment(content, assetAttrs, fn)
}
