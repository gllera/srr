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

// assetAttrs lists every element/attribute pair whose value the END-OF-PIPELINE
// UPLOAD STEP may rewrite from a "#"-marker to an assets/ key: embedded media
// plus <a href> (linked files). Every entry must be one the sanitizer keeps
// (mod/sanitize.go) or the rewritten key would be stripped before storage.
var assetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
	"a":     {"href"},
}

// mediaAttrs is the subset #selfhost DOWNLOADS: embedded-media src/poster only,
// NOT <a href> (a link is navigation, not auto-loaded media). <video poster>
// self-hosts because #selfhost runs after #sanitize (see the design's placement
// section), so the marker it writes is never re-sanitized.
var mediaAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
}

// markerShapeRe matches the raw shape every marker-bearing attribute must
// have: `=`, optional whitespace, optional quote, then the "#" prefix. A bare
// `#` elsewhere (URL fragments, entities — very common) can never parse into
// a marker, so it must not trigger the fragment parse below. Entity-encoded
// prefixes (&num;) are outside the marker contract: cooperating fetchers emit
// the literal "#", and the pipeline built-ins never entity-encode it.
var markerShapeRe = regexp.MustCompile(`=\s*["']?#`)

// HasAssetMarkers reports whether content can carry any "#"-upload marker. A
// marker is always a whole attribute value, so content without the `=["']?#`
// shape holds none — this is the cheap pre-check (memchr-speed common case:
// #feed feeds never emit markers). The asset-upload pass uses it to skip
// marker-less items without spawning a goroutine; RewriteAttrs uses it to skip
// the HTML parse entirely.
func HasAssetMarkers(content string) bool {
	return strings.Contains(content, "#") && markerShapeRe.MatchString(content)
}

// RewriteAttrs walks the assetAttrs values in content and rewrites their
// "#"-prefixed upload markers via fn (the "#" already stripped). Non-marker
// values never reach fn. Unparseable content and a no-op pass both return the
// original string verbatim. It is the asset-upload walk behind the
// end-of-pipeline step in main.Feed.fetch: fn owns the upload policy.
func RewriteAttrs(content string, fn func(marker string) (string, bool, error)) (string, error) {
	// Marker-less content holds no upload markers — skip the HTML parse entirely
	// (see HasAssetMarkers for the why; #feed feeds hit this common case).
	if !HasAssetMarkers(content) {
		return content, nil
	}
	return walkAssetAttrs(content, assetAttrs, func(val string) (string, bool, error) {
		if !strings.HasPrefix(val, "#") {
			return "", false, nil
		}
		return fn(strings.TrimPrefix(val, "#"))
	})
}

// walkAssetAttrs parses content as an HTML fragment and calls fn(value) for
// every attribute listed in attrs (tag -> attr names). fn returns
// (newValue, true, nil) to replace the value, (_, false, nil) to leave it, or a
// non-nil error to abort the walk. Unparseable content and a no-op pass both
// return content verbatim (no re-render), so quoting/whitespace survive when
// nothing changed; an fn or render error is returned with an empty string. It
// is the shared HTML walk behind both the upload step (RewriteAttrs, marker ->
// key) and #selfhost (URL -> marker).
func walkAssetAttrs(content string, attrs map[string][]string, fn func(val string) (string, bool, error)) (string, error) {
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
		c, err := walkNode(n, attrs, fn)
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

// walkNode applies fn to the attrs-listed attributes on n and its descendants,
// replacing each value when fn returns ok. Returns true if any value changed, or
// the first error fn returns (which stops the walk).
func walkNode(n *html.Node, attrs map[string][]string, fn func(val string) (string, bool, error)) (bool, error) {
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
		cc, err := walkNode(c, attrs, fn)
		if err != nil {
			return false, err
		}
		if cc {
			changed = true
		}
	}
	return changed, nil
}
