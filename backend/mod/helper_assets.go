package mod

import (
	"context"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// cacheDirKey is the unexported context key carrying the fetch run's shared
// asset cache dir. main.Feed.Fetch stamps it via WithCacheDir; #selfhost reads
// it via cacheDirFromContext. A run-scoped working directory crossing the
// main->mod boundary is a legitimate context.Value use; an absent value (e.g.
// srr preview, the Validate sentinel) reads back as "" and #selfhost no-ops.
type cacheDirKey struct{}

// WithCacheDir returns ctx with the fetch run's shared cache dir attached.
func WithCacheDir(ctx context.Context, dir string) context.Context {
	return context.WithValue(ctx, cacheDirKey{}, dir)
}

// cacheDirFromContext returns the cache dir stamped by WithCacheDir, or "" when
// none is set.
func cacheDirFromContext(ctx context.Context) string {
	dir, _ := ctx.Value(cacheDirKey{}).(string)
	return dir
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

// markerShapeRe matches the raw shape every marker-bearing attribute must
// have: `=`, optional whitespace, optional quote, then the "#" prefix. A bare
// `#` elsewhere (URL fragments, entities — very common) can never parse into
// a marker, so it must not trigger the fragment parse below. Entity-encoded
// prefixes (&num;) are outside the marker contract: cooperating fetchers emit
// the literal "#", and the pipeline built-ins never entity-encode it.
var markerShapeRe = regexp.MustCompile(`=\s*["']?#`)

// RewriteAttrs walks every self-hostable attribute value in content (img/video
// src/poster, a href — see assetAttrs) and rewrites its "#"-prefixed upload
// markers: for each marker it calls fn with the remainder (the "#" already
// stripped), which returns (newValue, true, nil) to replace the whole value,
// (_, false, nil) to leave the marker untouched, or a non-nil error to abort the
// walk and surface it to the caller. Non-marker values are passed through without
// reaching fn. It is the asset-upload walk behind the end-of-pipeline step
// inlined in main.Feed.fetch: fn owns the upload policy — how the referenced
// files are stored and which failures are fatal — while the marker convention
// (the "#" prefix) lives here. Unparseable content and a no-op pass both return
// the original string verbatim (no re-render), so quoting/whitespace survives
// when nothing changed; a fn or render error is returned alongside an empty
// string.
func RewriteAttrs(content string, fn func(marker string) (string, bool, error)) (string, error) {
	// A marker is always a whole attribute value, so content without the
	// `=["']?#` shape can hold none (this also covers empty content): skip the
	// parse+walk entirely. The Contains pass keeps the common case — built-in
	// #feed feeds never emit markers, and most content has no "#" at all — at
	// memchr speed; the regexp scan runs only when a "#" exists, sparing the
	// fragment parse for bare URL fragments and entities.
	if !strings.Contains(content, "#") || !markerShapeRe.MatchString(content) {
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
		c, err := applyAttrs(n, fn)
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
// markers among the assetAttrs values in place: for each marker it calls fn
// with the remainder (the "#" stripped) and replaces the whole value when fn
// returns ok. Non-marker values are skipped without reaching fn. Returns true
// if any value was rewritten, or the first error fn returns (which stops the
// walk).
func applyAttrs(n *html.Node, fn func(marker string) (string, bool, error)) (bool, error) {
	changed := false
	if n.Type == html.ElementNode {
		if names, ok := assetAttrs[n.Data]; ok {
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
		cc, err := applyAttrs(c, fn)
		if err != nil {
			return false, err
		}
		if cc {
			changed = true
		}
	}
	return changed, nil
}
