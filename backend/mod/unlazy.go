package mod

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// #unlazy — recover lazy-loaded images before the sanitizer discards them.
//
// Modern CMS pages (and the article pages #readability fetches) ship images
// as <img src="placeholder" data-src="real.jpg">, with the real URL in a
// data-* attribute, a srcset, or a <noscript> fallback the page's JS would
// promote at scroll time. No JS runs in a feed reader, and #sanitize keeps
// only src on <img> — so without this step those articles publish with
// blank or 1-px images and there is no recovery downstream.
//
// Four fixes, applied in order:
//   - a data-src-style attribute (lazySrcAttrs, URL-shaped values only)
//     replaces src on <img>/<video>/<audio>;
//   - an <img> whose src is still missing or a placeholder takes the best
//     srcset/data-srcset candidate (largest width, else density, else first);
//   - a <video>/<audio> still without a usable src takes the best <source src>
//     child — #sanitize keeps src only on the media element and drops <source>
//     entirely, so the standard WordPress/Gutenberg video block would otherwise
//     publish as an empty element;
//   - a <noscript> whose markup contributes an image the document doesn't
//     already show is unwrapped in place; a redundant one (same file as the
//     promoted sibling) is dropped.
//
// Takes no parameters. Pure CPU, never fails an item: unparseable content
// passes through untouched, an untouched item returns verbatim (no
// re-render). Place it BEFORE #sanitize (e.g. ["#unlazy", "#default"]) —
// after it the data-* attributes holding the real URLs are gone.

func init() {
	Register("unlazy", func() Processor {
		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			i.Content = unlazyContent(i.Content)
			return nil
		}
	})
}

// lazySrcAttrs are the attributes lazy-load libraries stash the real URL in,
// in promotion priority order.
var lazySrcAttrs = []string{"data-src", "data-lazy-src", "data-original", "data-orig-src", "data-lazyload"}

var (
	// lazyURLRe accepts a candidate that is plausibly a URL (absolute,
	// protocol-relative, or rooted); libraries also stash booleans/JSON in
	// data-* attributes and those must never become a src.
	lazyURLRe = regexp.MustCompile(`(?i)^(https?://|//|/)`)
	// lazyPlaceholderRe marks a src as a stand-in whose real URL should come
	// from srcset: inline data URIs, about:blank, and stock placeholder file
	// names (1-px gifs, loading spinners).
	lazyPlaceholderRe = regexp.MustCompile(`(?i)^data:|^about:blank$|/(1x1|blank|spacer|pixel|placeholder|loading|lazy|grey|gray|transparent)[^/]*\.(gif|png|svg|jpe?g|webp)([?#]|$)`)
)

// unlazyContent promotes lazy-load URLs in content. Returns content verbatim
// when nothing changed (or nothing parsed), so quoting/whitespace survive the
// no-op pass.
func unlazyContent(content string) string {
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "data-") && !strings.Contains(lower, "srcset") &&
		!strings.Contains(lower, "<noscript") && !strings.Contains(lower, "<source") {
		return content
	}
	body := parseBodyHTML(content)
	if body == nil {
		return content
	}

	changed := false
	seen := map[string]bool{} // media file IDs visible after promotion
	var noscripts []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "img":
				if promoteLazyImg(n) {
					changed = true
				}
				if src := strings.TrimSpace(mediaAttr(n, "src")); src != "" {
					seen[mediaFileID(src)] = true
				}
			case "video", "audio":
				if c, _ := promoteLazyDataSrc(n); c {
					changed = true
				}
				if hoistSourceSrc(n) {
					changed = true
				}
			case "noscript":
				noscripts = append(noscripts, n)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(body)
	for _, ns := range noscripts {
		if unwrapNoscript(ns, seen) {
			changed = true
		}
	}
	if !changed {
		return content
	}
	out, ok := renderBodyHTML(body)
	if !ok {
		return content
	}
	return out
}

// promoteLazyDataSrc moves the first URL-shaped lazySrcAttrs value into src.
// found reports whether a candidate existed at all — it IS the real URL, so
// the caller must not fall back to srcset when src already equals it.
func promoteLazyDataSrc(n *html.Node) (changed, found bool) {
	src := strings.TrimSpace(mediaAttr(n, "src"))
	for _, k := range lazySrcAttrs {
		if v := strings.TrimSpace(mediaAttr(n, k)); v != "" && lazyURLRe.MatchString(v) {
			if v != src {
				setNodeAttr(n, "src", v)
				return true, true
			}
			return false, true
		}
	}
	return false, false
}

// promoteLazyImg applies the data-* promotion, then fills a missing or
// placeholder src from the best srcset candidate. A genuine src is never
// overridden by srcset — only lazy stand-ins are.
func promoteLazyImg(n *html.Node) bool {
	changed, found := promoteLazyDataSrc(n)
	if found {
		return changed
	}
	src := strings.TrimSpace(mediaAttr(n, "src"))
	if src != "" && !lazyPlaceholderRe.MatchString(src) {
		return false
	}
	for _, k := range []string{"data-srcset", "srcset"} {
		if u := bestSrcsetURL(mediaAttr(n, k)); u != "" && u != src {
			setNodeAttr(n, "src", u)
			return true
		}
	}
	return false
}

// hoistPreferred names the containers a browser is most likely to play,
// matched against a <source type> subtype and against the URL extension. An
// unpreferred candidate is still hoisted when it is the only one: any src beats
// an element the sanitizer will publish empty.
var hoistPreferred = map[string]bool{
	"mp4": true, "webm": true, "m4v": true, "ogv": true,
	"mpeg": true, "mp3": true, "m4a": true, "aac": true,
	"ogg": true, "oga": true, "wav": true, "flac": true,
}

// hoistSchemeRe matches an explicit URL scheme; a relative reference (including
// "//host" and "/rooted") never matches.
var hoistSchemeRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*:`)

// hoistSourceSrc promotes a <source src> child onto a <video>/<audio> that has
// no usable src of its own. #sanitize allows src only on the media element and
// drops <source> wholesale, so the standard WordPress/Gutenberg video block —
// <video controls> wrapping <source> children — publishes as an empty element
// into immutable packs with no repair downstream. The best preferred-container
// candidate wins (a declared type= outranks the URL extension); ties keep
// document order.
func hoistSourceSrc(n *html.Node) bool {
	if src := strings.TrimSpace(mediaAttr(n, "src")); src != "" && !lazyPlaceholderRe.MatchString(src) {
		return false
	}
	best, bestRank := "", -1
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "source" {
			continue
		}
		v := strings.TrimSpace(mediaAttr(c, "src"))
		if !hoistableSrc(v) {
			continue
		}
		if r := sourceRank(c, v); r > bestRank {
			best, bestRank = v, r
		}
	}
	if best == "" {
		return false
	}
	setNodeAttr(n, "src", best)
	return true
}

// hoistableSrc accepts a <source src> worth promoting: a relative reference
// (the reader resolves it against the pack base) or an absolute http(s) URL. A
// data:/blob:/javascript: value is never promoted — bluemonday would strip it
// downstream, and #unlazy may run in a pipe without #sanitize.
func hoistableSrc(v string) bool {
	if v == "" || lazyPlaceholderRe.MatchString(v) {
		return false
	}
	if !hoistSchemeRe.MatchString(v) {
		return true
	}
	return mediaSchemeRe.MatchString(v)
}

// sourceRank scores a <source> candidate: 2 = a preferred container declared in
// type=, 1 = a preferred container by URL extension, 0 = usable but unknown.
func sourceRank(c *html.Node, src string) int {
	if t := strings.ToLower(strings.TrimSpace(mediaAttr(c, "type"))); t != "" {
		sub := t
		if i := strings.Index(sub, "/"); i >= 0 {
			sub = sub[i+1:]
		}
		if i := strings.IndexAny(sub, "; "); i >= 0 { // "video/mp4; codecs=avc1"
			sub = sub[:i]
		}
		if hoistPreferred[sub] {
			return 2
		}
	}
	u := src
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	if ext := cleanExt(u); ext != "" && hoistPreferred[ext[1:]] {
		return 1
	}
	return 0
}

// bestSrcsetURL picks the richest candidate from a srcset value: highest
// width descriptor, else highest density, else the first URL-shaped entry.
func bestSrcsetURL(srcset string) string {
	bestURL, first := "", ""
	bestW, bestX := -1, -1.0
	for entry := range strings.SplitSeq(srcset, ",") {
		fields := strings.Fields(entry)
		if len(fields) == 0 || !lazyURLRe.MatchString(fields[0]) {
			continue
		}
		u := fields[0]
		if first == "" {
			first = u
		}
		if len(fields) < 2 {
			continue
		}
		if d, ok := strings.CutSuffix(fields[1], "w"); ok {
			if w, err := strconv.Atoi(d); err == nil && w > bestW {
				bestW, bestURL = w, u
			}
			continue
		}
		if d, ok := strings.CutSuffix(fields[1], "x"); ok && bestW < 0 {
			if x, err := strconv.ParseFloat(d, 64); err == nil && x > bestX {
				bestX, bestURL = x, u
			}
		}
	}
	if bestURL != "" {
		return bestURL
	}
	return first
}

// unwrapNoscript replaces a <noscript> fallback with its markup when that
// markup contributes an image the document doesn't already show; a redundant
// fallback (same files as the promoted siblings) is dropped entirely. The
// parser treats noscript children as raw text, so the payload is re-parsed.
func unwrapNoscript(ns *html.Node, seen map[string]bool) bool {
	var raw strings.Builder
	for c := ns.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.TextNode {
			raw.WriteString(c.Data)
		}
	}
	txt := raw.String()
	if !strings.Contains(strings.ToLower(txt), "<img") {
		return false
	}
	frag := parseBodyHTML(txt)
	if frag == nil {
		return false
	}
	fresh := false
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "img" {
			if src := strings.TrimSpace(mediaAttr(n, "src")); src != "" {
				if id := mediaFileID(src); !seen[id] {
					fresh = true
					seen[id] = true
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(frag)
	parent := ns.Parent
	if fresh {
		for frag.FirstChild != nil {
			c := frag.FirstChild
			frag.RemoveChild(c)
			parent.InsertBefore(c, ns)
		}
	}
	parent.RemoveChild(ns)
	return true
}
