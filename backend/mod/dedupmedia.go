package mod

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// #dedupmedia — an article never shows the same picture (or video/audio)
// twice; the best copy survives.
//
// WordPress "featured image in feed" plugins prepend a copy of an image the
// body already contains (finofilipino.org), and equivalent duplicates arise
// from CDN proxies and size variants. This step groups <img>/<video>/<audio>
// elements by the file they actually show and removes all but the richest
// copy of each group.
//
// Two URLs are the same file when they match after normalization
// (mediaFileID): scheme and query/fragment ignored, a WordPress size suffix
// stripped (foo-383x680.jpg -> foo.jpg), a wp.com Photon proxy unwrapped
// (i0.wp.com/site/x.jpg -> site/x.jpg).
//
// The kept copy of a group, in priority order (mediaScore): the canonical
// file (an un-suffixed, un-proxied URL beats a resized variant), then alt
// text, then declared pixel area, then attribute richness; ties keep
// document order. Wrappers a removal leaves saying nothing (<a>, <p>,
// <figure> chains without text or other media) are pruned.
//
// Images functioning as text or layout are exempt (isMediaGlyph) — repeating
// them is the point: emoji renderers (class/style/alt/s.w.org signals),
// anything declaring both sides <= 96 px, and blank/spacer/pixel/placeholder
// file names never join a dedup group.
//
// Takes no parameters. Pure CPU, never fails an item: unparseable content
// passes through untouched, an untouched item returns verbatim (no
// re-render). Place it BEFORE #sanitize (e.g. ["#dedupmedia", "#default"])
// so the glyph heuristics still see the class/style attributes the
// sanitizer strips.

func init() {
	Register("dedupmedia", func() Processor {
		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			i.Content = dedupMedia(i.Content)
			return nil
		}
	})
}

// dedupMediaTags are the element types deduplicated, each by its own
// (tag, file) identity — an <img> and a <video> off one URL render
// differently and never merge.
var dedupMediaTags = map[string]bool{"img": true, "video": true, "audio": true}

// dedupKeepTags are elements whose presence keeps a wrapper alive during
// pruning even when it holds no text.
var dedupKeepTags = map[string]bool{
	"img": true, "video": true, "audio": true, "iframe": true, "table": true,
}

var (
	mediaSchemeRe  = regexp.MustCompile(`^(?i:https?)://`)
	mediaPhotonRe  = regexp.MustCompile(`^(?i:i[0-9]\.wp\.com/)`)
	mediaWPSizeRe  = regexp.MustCompile(`-\d+x\d+(\.[A-Za-z0-9]+)$`)
	glyphNameRe    = regexp.MustCompile(`(?i)/(blank|spacer|pixel|placeholder|loading)[^/]*\.(gif|png|svg)$`)
	glyphEmStyleRe = regexp.MustCompile(`(?i)(max-)?height:\s*[0-9.]+em`)
)

// glyphClasses mark an <img> as an inline text glyph (emoji renderers).
var glyphClasses = map[string]bool{"emoji": true, "wp-smiley": true, "smiley": true}

// dedupMedia removes duplicate media copies from content. It returns content
// verbatim when nothing changed (or nothing parsed), so quoting/whitespace
// survive the no-op pass.
func dedupMedia(content string) string {
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "<img") && !strings.Contains(lower, "<video") &&
		!strings.Contains(lower, "<audio") {
		return content
	}

	// One synthetic body over the fragment so removal and wrapper pruning
	// treat top-level nodes like any other.
	body := parseBodyHTML(content)
	if body == nil {
		return content
	}

	type fileKey struct{ tag, file string }
	groups := map[fileKey][]*html.Node{}
	var collect func(*html.Node)
	collect = func(n *html.Node) {
		if n.Type == html.ElementNode && dedupMediaTags[n.Data] {
			if src := strings.TrimSpace(mediaAttr(n, "src")); src != "" && !isMediaGlyph(n) {
				k := fileKey{n.Data, mediaFileID(src)}
				groups[k] = append(groups[k], n)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			collect(c)
		}
	}
	collect(body)

	changed := false
	for _, copies := range groups {
		if len(copies) < 2 {
			continue
		}
		best := 0
		for i := 1; i < len(copies); i++ {
			if mediaScore(copies[i]).beats(mediaScore(copies[best])) {
				best = i
			}
		}
		for i, n := range copies {
			if i == best {
				continue
			}
			parent := n.Parent
			parent.RemoveChild(n)
			pruneEmptyWrappers(parent, body)
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

// mediaFileID normalizes a media URL to the file identity behind it (see the
// module doc). Two elements with equal IDs show the same picture.
func mediaFileID(src string) string {
	u := mediaSchemeRe.ReplaceAllString(strings.TrimSpace(src), "")
	u = mediaPhotonRe.ReplaceAllString(u, "")
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	return mediaWPSizeRe.ReplaceAllString(u, "$1")
}

// dedupScore ranks duplicate copies; higher wins, ties keep document order.
type dedupScore struct {
	canonical bool // the URL IS the file identity (no size suffix/proxy/query)
	hasAlt    bool
	area      int
	attrs     int
}

func (a dedupScore) beats(b dedupScore) bool {
	if a.canonical != b.canonical {
		return a.canonical
	}
	if a.hasAlt != b.hasAlt {
		return a.hasAlt
	}
	if a.area != b.area {
		return a.area > b.area
	}
	return a.attrs > b.attrs
}

func mediaScore(n *html.Node) dedupScore {
	src := strings.TrimSpace(mediaAttr(n, "src"))
	return dedupScore{
		canonical: mediaFileID(src) == mediaSchemeRe.ReplaceAllString(src, ""),
		hasAlt:    strings.TrimSpace(mediaAttr(n, "alt")) != "",
		area:      pxDim(mediaAttr(n, "width")) * pxDim(mediaAttr(n, "height")),
		attrs:     len(n.Attr),
	}
}

// isMediaGlyph reports whether an <img> functions as text or layout —
// repetition is meaningful there, so it never joins a dedup group.
func isMediaGlyph(n *html.Node) bool {
	if n.Data != "img" {
		return false
	}
	for c := range strings.FieldsSeq(mediaAttr(n, "class")) {
		if glyphClasses[strings.ToLower(c)] {
			return true
		}
	}
	if glyphEmStyleRe.MatchString(mediaAttr(n, "style")) {
		return true
	}
	src := mediaAttr(n, "src")
	if strings.Contains(src, "s.w.org/images/core/emoji") {
		return true
	}
	if alt := strings.TrimSpace(mediaAttr(n, "alt")); alt != "" && utf8.RuneCountInString(alt) <= 2 {
		for _, r := range alt {
			if r > 0x2000 {
				return true
			}
		}
	}
	if w, h := pxDim(mediaAttr(n, "width")), pxDim(mediaAttr(n, "height")); w > 0 && w <= 96 && h > 0 && h <= 96 {
		return true
	}
	return glyphNameRe.MatchString(strings.SplitN(src, "?", 2)[0])
}

// pruneEmptyWrappers climbs from a removed node's parent, dropping wrappers
// that no longer hold text or keep-worthy elements, stopping at stop.
func pruneEmptyWrappers(n, stop *html.Node) {
	for n != nil && n != stop && !hasRealContent(n) {
		parent := n.Parent
		parent.RemoveChild(n)
		n = parent
	}
}

func hasRealContent(n *html.Node) bool {
	if n.Type == html.TextNode && strings.TrimSpace(n.Data) != "" {
		return true
	}
	if n.Type == html.ElementNode && dedupKeepTags[n.Data] {
		return true
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if hasRealContent(c) {
			return true
		}
	}
	return false
}

// mediaAttr returns the value of the named attribute, or "".
func mediaAttr(n *html.Node, name string) string {
	for _, a := range n.Attr {
		if a.Key == name {
			return a.Val
		}
	}
	return ""
}

// pxDim parses the leading decimal digits of a width/height attribute value
// ("383", "383px"); anything else is 0.
func pxDim(s string) int {
	v, ok := 0, false
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		v, ok = v*10+int(r-'0'), true
		if v > 1<<20 {
			break
		}
	}
	if !ok {
		return 0
	}
	return v
}
