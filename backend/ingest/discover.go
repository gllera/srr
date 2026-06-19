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

	z := html.NewTokenizer(bytes.NewReader(htmlData))
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			// EOF or error — stop scanning.
			return "", false

		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			if !hasAttr || string(name) != "link" {
				continue
			}
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
			if href == "" || !isAlternateRel(rel) || !isFeedType(typ) {
				continue
			}
			resolved := resolveHref(href, base)
			if resolved == "" {
				continue
			}
			return resolved, true
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
	switch strings.ToLower(strings.TrimSpace(typ)) {
	case "application/rss+xml", "application/atom+xml", "application/feed+json":
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
