package ingest

import (
	"bytes"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

// discoverFeedLink scans htmlData for a <link rel="alternate"> element whose
// type is a recognised feed MIME type (RSS, Atom, or JSON Feed). It returns
// the first match's href resolved to an absolute URL against baseURL, and
// true on success. Returns ("", false) when no qualifying link is found.
//
// Uses golang.org/x/net/html.NewTokenizer for robustness against malformed
// and partial HTML (already in go.mod via x/net).
func discoverFeedLink(htmlData []byte, baseURL string) (string, bool) {
	base, err := url.Parse(baseURL)
	if err != nil {
		// If the base URL can't be parsed we can still return an absolute href.
		base = nil
	}
	// A <base href> in the document overrides baseURL for relative resolution
	// (HTML spec). First one wins; resolved against the page URL if itself relative.
	var baseOverride *url.URL

	z := html.NewTokenizer(bytes.NewReader(htmlData))
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			// EOF or error — stop scanning.
			return "", false

		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			if !hasAttr {
				continue
			}
			switch string(name) {
			case "base":
				for {
					k, v, more := z.TagAttr()
					if baseOverride == nil && strings.EqualFold(string(k), "href") {
						if h := strings.TrimSpace(string(v)); h != "" {
							if u, perr := url.Parse(h); perr == nil {
								if base != nil {
									baseOverride = base.ResolveReference(u)
								} else {
									baseOverride = u
								}
							}
						}
					}
					if !more {
						break
					}
				}
			case "link":
				// Collect all attributes of this <link> tag.
				var rel, typ, href string
				for {
					k, v, more := z.TagAttr()
					switch strings.ToLower(string(k)) {
					case "rel":
						rel = string(v)
					case "type":
						typ = string(v)
					case "href":
						href = string(v)
					}
					if !more {
						break
					}
				}
				href = strings.TrimSpace(href)
				if href == "" || !isAlternateRel(rel) || !isFeedType(typ) {
					continue
				}
				effectiveBase := base
				if baseOverride != nil {
					effectiveBase = baseOverride
				}
				resolved := resolveHref(href, effectiveBase)
				if resolved == "" {
					continue
				}
				return resolved, true
			}
		}
	}
}

// isAlternateRel reports whether the rel attribute value (possibly
// space-separated and any case) contains "alternate".
func isAlternateRel(rel string) bool {
	for token := range strings.FieldsSeq(rel) {
		if strings.EqualFold(token, "alternate") {
			return true
		}
	}
	return false
}

// isFeedType reports whether the MIME type is a recognised feed type.
func isFeedType(typ string) bool {
	// Strip any MIME parameter (e.g. "; charset=utf-8") before matching.
	if i := strings.IndexByte(typ, ';'); i >= 0 {
		typ = typ[:i]
	}
	switch strings.ToLower(strings.TrimSpace(typ)) {
	// JSON Feed (application/feed+json) is deliberately NOT discoverable: the
	// built-in #feed parser (ParseFeed) reads only XML roots (RSS/Atom/RDF), so
	// auto-discovering a JSON-only feed would repoint to a URL #feed can't parse —
	// hard-failing the add/import or wedging the feed. Report "no feed" instead.
	case "application/rss+xml", "application/atom+xml":
		return true
	}
	return false
}

// resolveHref resolves href against base. If base is nil or href is already
// absolute, it is returned as-is (after parsing). Returns "" on error.
func resolveHref(href string, base *url.URL) string {
	ref, err := url.Parse(href)
	if err != nil {
		return ""
	}
	if base != nil {
		return base.ResolveReference(ref).String()
	}
	return ref.String()
}
