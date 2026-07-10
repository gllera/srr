package mod

import (
	"context"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// #untrack — strip the tracking freight feeds ship inside article content.
//
// Three cleanups:
//   - tracking pixels: an <img> declaring both sides <= 2px, or whose src
//     matches a known beacon endpoint (feedburner ~4, Mailchimp open.php,
//     WordPress.com stats, Google Analytics, Facebook tr, …) is removed and
//     its emptied wrappers pruned;
//   - tracking query parameters (utm_*, fbclid, gclid, mc_eid, …) are
//     dropped from <a href> and media src/poster URLs — parameters that only
//     identify the reader or campaign, never the resource. Other parameters
//     keep their order and encoding verbatim; non-http(s) URLs are never
//     touched;
//   - the WordPress trailer: a final "The post X appeared first on Y" block
//     is removed (matched only as the last element of the article).
//
// Takes no parameters. Pure CPU, never fails an item: unparseable content
// passes through untouched, an untouched item returns verbatim (no
// re-render). Place it BEFORE #sanitize and AFTER #unlazy (e.g. ["#unlazy",
// "#untrack", "#default"]) — a not-yet-promoted lazy placeholder can declare
// 1x1 and must not be mistaken for a beacon (the size rule also skips any
// <img> still carrying a lazy data-src URL, so the order is belt-and-braces).

func init() {
	Register("untrack", func() Processor {
		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			i.Content = untrackContent(i.Content)
			return nil
		}
	})
}

// trackingParams are query parameters that only ever identify the reader or
// campaign, never the resource; stripping them is always content-preserving.
// utm_* is matched by prefix separately.
var trackingParams = map[string]bool{
	"fbclid": true, "gclid": true, "dclid": true, "gbraid": true, "wbraid": true,
	"msclkid": true, "mc_cid": true, "mc_eid": true, "igshid": true, "yclid": true,
	"twclid": true, "ttclid": true, "_hsenc": true, "_hsmi": true, "mkt_tok": true,
	"vero_id": true, "oly_enc_id": true, "oly_anon_id": true, "ck_subscriber_id": true,
}

var (
	// trackerPixelRe matches beacon endpoints regardless of declared size.
	trackerPixelRe = regexp.MustCompile(`(?i)(?:feedburner\.com/~r/.+/~4/|pixel\.wp\.com/|stats\.wordpress\.com/[bg]\.gif|list-manage\.com/track/open|google-analytics\.com/(?:collect|__utm\.gif)|facebook\.com/tr\b|b\.scorecardresearch\.com/|pixel\.quantserve\.com/|ad\.doubleclick\.net/|mc\.yandex\.ru/watch/)`)
	// wpTrailerRe matches the WordPress syndication trailer, whitespace
	// collapsed, as the whole text of a trailing block.
	wpTrailerRe = regexp.MustCompile(`(?i)^the post .+ (?:appeared first|first appeared) on .+$`)
)

// untrackAttrs lists the URL-bearing attributes cleaned per element.
var untrackAttrs = map[string][]string{
	"a": {"href"}, "img": {"src"}, "video": {"src", "poster"},
	"audio": {"src"}, "source": {"src"},
}

// untrackContent applies the cleanups to content. Returns content verbatim
// when nothing changed (or nothing parsed).
func untrackContent(content string) string {
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "?") && !strings.Contains(lower, "<img") &&
		!strings.Contains(lower, "the post") {
		return content
	}
	body := parseBodyHTML(content)
	if body == nil {
		return content
	}

	changed := false
	var pixels []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if n.Data == "img" && isTrackerPixel(n) {
				pixels = append(pixels, n)
			} else {
				for _, key := range untrackAttrs[n.Data] {
					if v := mediaAttr(n, key); v != "" {
						if cleaned, ok := stripTrackingParams(v); ok {
							setNodeAttr(n, key, cleaned)
							changed = true
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(body)

	for _, n := range pixels {
		parent := n.Parent
		parent.RemoveChild(n)
		pruneEmptyWrappers(parent, body)
		changed = true
	}
	if removeWPTrailer(body) {
		changed = true
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

// isTrackerPixel reports whether an <img> is an analytics beacon: a known
// endpoint, or both sides declared <= 2px. An element still carrying a lazy
// data-src URL is never size-classified — the placeholder may declare 1x1
// while the real image waits in the data attribute.
func isTrackerPixel(n *html.Node) bool {
	if trackerPixelRe.MatchString(mediaAttr(n, "src")) {
		return true
	}
	for _, k := range lazySrcAttrs {
		if v := strings.TrimSpace(mediaAttr(n, k)); v != "" && lazyURLRe.MatchString(v) {
			return false
		}
	}
	w, wok := declaredPx(mediaAttr(n, "width"))
	h, hok := declaredPx(mediaAttr(n, "height"))
	return wok && hok && w <= 2 && h <= 2
}

// declaredPx parses a numeric width/height attribute; ok=false when the
// attribute is absent or does not start with a digit.
func declaredPx(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s[0] < '0' || s[0] > '9' {
		return 0, false
	}
	return pxDim(s), true
}

// stripTrackingParams removes tracking query parameters from an http(s) URL,
// preserving the remaining query verbatim (order and encoding). ok reports
// whether anything was removed.
func stripTrackingParams(raw string) (string, bool) {
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return raw, false
	}
	// Split the fragment off FIRST: a fragment may itself contain "?" (a hash
	// router route like "#route?x=1"), so cutting on "?" before "#" would parse a
	// spurious query out of the fragment and drop part of it. A real query always
	// precedes the fragment, so this ordering is also correct for the common case.
	beforeFrag, frag := raw, ""
	if before, after, cut := strings.Cut(raw, "#"); cut {
		beforeFrag, frag = before, "#"+after
	}
	base, query, found := strings.Cut(beforeFrag, "?")
	if !found {
		return raw, false
	}
	var kept []string
	dropped := false
	for seg := range strings.SplitSeq(query, "&") {
		name, _, _ := strings.Cut(seg, "=")
		name = strings.ToLower(name)
		if strings.HasPrefix(name, "utm_") || trackingParams[name] {
			dropped = true
			continue
		}
		kept = append(kept, seg)
	}
	if !dropped {
		return raw, false
	}
	if len(kept) == 0 {
		return base + frag, true
	}
	return base + "?" + strings.Join(kept, "&") + frag, true
}

// removeWPTrailer drops a final "The post X appeared first on Y" block — the
// WordPress syndication footer. Only the last element child of the body is
// considered; the phrase mid-article is left alone.
func removeWPTrailer(body *html.Node) bool {
	last := body.LastChild
	for last != nil && last.Type == html.TextNode && strings.TrimSpace(last.Data) == "" {
		last = last.PrevSibling
	}
	if last == nil || last.Type != html.ElementNode {
		return false
	}
	txt := strings.Join(strings.Fields(nodeText(last)), " ")
	if !wpTrailerRe.MatchString(txt) {
		return false
	}
	body.RemoveChild(last)
	return true
}

// nodeText concatenates the text nodes under n.
func nodeText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}
