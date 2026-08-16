package mod

import (
	"context"
	"regexp"

	"github.com/microcosm-cc/bluemonday"
)

// The policy's attribute-value patterns, compiled once for the process rather
// than once per Register factory call. mod.New() runs per pooled Module and
// the pool is emptied at every GC, so these compiles were being redone all
// through a fetch cycle -- around 80 percent of New()'s time and garbage. A
// *regexp.Regexp is safe for concurrent use and bluemonday only stores the
// pointer, so one shared instance per pattern is behaviour-identical.
// boolAttr returns the HTML boolean-attribute value rule for one attribute:
// present-and-empty, or repeating its own name. Six attributes wanted exactly
// that pattern and each carried a hand-written copy, where the ONLY thing
// binding `muted` to its own pattern was that someone typed the right variable
// name — a paste slip pairing controls' regexp with `muted` compiles, passes any
// test that merely checks the attribute survives, and quietly widens what the
// sanitizer accepts. Derived from the name, the pairing cannot be wrong; the
// emitted patterns are byte-identical to the six they replace.
//
// Compiled once at init, like every other pattern in this file: the policy is
// rebuilt per mod.New(), and the Module pool is emptied at every GC.
var boolAttrRes = func() map[string]*regexp.Regexp {
	out := map[string]*regexp.Regexp{}
	for _, name := range []string{"controls", "playsinline", "autoplay", "muted", "loop", "open"} {
		out[name] = regexp.MustCompile(`(?i)^(|` + regexp.QuoteMeta(name) + `)$`)
	}
	return out
}()

func boolAttr(name string) *regexp.Regexp {
	re, ok := boolAttrRes[name]
	if !ok {
		// A name this file allowlists but never compiled. Unreachable — both
		// lists are literals here — and loud rather than a nil Matching().
		panic("mod: no boolean-attribute pattern for " + name)
	}
	return re
}

var (
	reVideoPoster  = regexp.MustCompile(`(?i)^(https?://|assets/)`)
	rePreloadToken = regexp.MustCompile(`(?i)^(none|metadata|auto)$`)
	reTTSTimes     = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?(,[0-9]+(\.[0-9]+)?)*$`)
	reTTSIndex     = regexp.MustCompile(`^[0-9]{1,4}$`)
	reLangAttr     = regexp.MustCompile(`[a-zA-Z]{2,20}`)
	reElementID    = regexp.MustCompile(`^[A-Za-z][\w:.-]{0,63}$`)
	reMapName      = regexp.MustCompile(`^([\p{L}\p{N}_-]+)$`)
	reAreaCoords   = regexp.MustCompile(`^([0-9]+,)+[0-9]+$`)
	reAreaShape    = regexp.MustCompile(`(?i)^(default|circle|rect|poly)$`)
	reUsemap       = regexp.MustCompile(`(?i)^#[\p{L}\p{N}_-]+$`)
)

func init() {
	Register("sanitize", func() Processor {
		policy := bluemonday.StrictPolicy()

		policy.AllowLists()
		policy.AllowTables()
		// Equivalent of policy.AllowImages() but without srcset — the frontend
		// strips it defensively (frontend/src/js/fmt.ts) and there is no use
		// case for it in stored feed content.
		policy.AllowAttrs("align").Matching(bluemonday.ImageAlign).OnElements("img")
		policy.AllowAttrs("alt").Matching(bluemonday.Paragraph).OnElements("img")
		policy.AllowAttrs("height", "width").Matching(bluemonday.NumberOrPercent).OnElements("img")
		policy.AllowAttrs("src").OnElements("img")
		policy.AllowAttrs("title").Matching(bluemonday.Paragraph).OnElements("img")
		policy.AllowElements("img")

		// Video player support — feeds may embed raw mp4 URLs.
		// width/height carry an optional aspect-ratio hint so the player
		// element starts at hint-derived dimensions instead of the
		// poster's intrinsic size. The frontend defense-in-depth
		// strips style/class/on* and URL_DENY schemes, mirroring this
		// allowlist.
		// bluemonday URL-scheme-validates a video's "src" but NOT its "poster",
		// so a poster="javascript:…"/"data:…" would otherwise survive into the
		// stored packs. Constrain poster to http(s) or the relative assets/ key
		// (the only forms the writer emits) so dangerous schemes are stripped.
		policy.AllowAttrs("src").OnElements("video")
		policy.AllowAttrs("poster").Matching(reVideoPoster).OnElements("video")
		policy.AllowAttrs("preload").Matching(rePreloadToken).OnElements("video")
		policy.AllowAttrs("controls").Matching(boolAttr("controls")).OnElements("video")
		policy.AllowAttrs("playsinline").Matching(boolAttr("playsinline")).OnElements("video")
		// GIF-style playback: srr-x (v1.4) rebuilds GIF tweets as muted looping
		// autoplaying video — the way every platform renders GIFs. Autoplay is
		// only honored by browsers when muted, so the trio is emitted together.
		policy.AllowAttrs("autoplay").Matching(boolAttr("autoplay")).OnElements("video")
		policy.AllowAttrs("muted").Matching(boolAttr("muted")).OnElements("video")
		policy.AllowAttrs("loop").Matching(boolAttr("loop")).OnElements("video")
		policy.AllowAttrs("width", "height").Matching(bluemonday.NumberOrPercent).OnElements("video")
		policy.AllowElements("video")

		// <audio> mirrors <video> minus the visual/poster attrs. bluemonday
		// URL-scheme-validates "src" like it does for video/img. controls and
		// preload are constrained to their valid token sets. #selfhost runs after
		// #sanitize, so <audio> must survive here for its media to be self-hosted;
		// the frontend (fmt.ts) forces controls so a control-less feed <audio>
		// still renders a player.
		policy.AllowAttrs("src").OnElements("audio")
		policy.AllowAttrs("preload").Matching(rePreloadToken).OnElements("audio")
		policy.AllowAttrs("controls").Matching(boolAttr("controls")).OnElements("audio")
		policy.AllowElements("audio")

		// srr-tts narration sync (paragraph highlight + click-to-seek in the
		// reader): data-tts-t on the narration <audio> is the segment
		// start-time table, data-tts on a block is its segment index. Values
		// are a comma-joined decimal list / a bounded digit run — nothing
		// else, so the pair carries no markup, URL or script surface. The
		// element list is the intersection of srr-tts's BLOCK_TAGS with what
		// this policy already allows (a stamp on e.g. <header> dies with its
		// element, and the reader treats the missing index as "no highlight").
		// A feed could stamp its own content pre-pipeline; the worst that
		// buys is a click seeking its own <audio> — accepted.
		policy.AllowAttrs("data-tts-t").Matching(reTTSTimes).OnElements("audio")
		policy.AllowAttrs("data-tts").Matching(reTTSIndex).OnElements(
			"p", "div", "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "pre",
			"table", "tr", "td", "th", "caption", "figure", "figcaption",
			"article", "section", "aside", "summary", "details",
			"h1", "h2", "h3", "h4", "h5", "h6")

		policy.RequireParseableURLs(true)
		policy.AllowRelativeURLs(true)
		// Kept in lockstep with the frontend's ANCHOR_ABS_OK allowlist
		// (fmt.ts) — the reader mirrors this set as defense-in-depth, so any
		// scheme added/removed here must move there too. tel/geo/magnet are
		// user-actionable navigation schemes (click-to-call, map, torrent).
		policy.AllowURLSchemes("mailto", "http", "https", "tel", "geo", "magnet")

		policy.AllowElements("article", "aside", "figure", "section", "summary", "hgroup")
		policy.AllowElements("h1", "h2", "h3", "h4", "h5", "h6")
		policy.AllowElements("br", "div", "hr", "p", "span", "wbr")
		policy.AllowElements("abbr", "acronym", "cite", "code", "dfn", "em", "figcaption", "mark", "s", "samp", "strong", "sub", "sup", "var")
		policy.AllowElements("b", "i", "pre", "small", "strike", "tt", "u")
		policy.AllowElements("rp", "rt", "ruby")

		policy.AllowElements("a", "blockquote", "details", "q", "time")
		policy.AllowElements("bdi", "bdo", "del", "ins")
		policy.AllowElements("meter", "progress")
		policy.AllowElements("area", "map")

		policy.AllowAttrs("dir").Matching(bluemonday.Direction).Globally()
		policy.AllowAttrs("lang").Matching(reLangAttr).Globally()
		// `id` is the LANDING half of an in-page fragment link. Stripping it made
		// every footnote, endnote and table-of-contents link in a longform article
		// a dead reference — the anchor survived, its target did not. The reader
		// resolves such links inside the article and scrolls to them (fmt.ts
		// FRAGMENT_HREF / handleFragmentClick).
		//
		// Conservative on purpose: a leading letter then word characters, colon,
		// dot or dash, bounded — that covers every footnote convention feeds
		// actually emit (fn1, fnref:3, footnote-12) and refuses the exotic values
		// HTML5 technically permits. Content ids are scoped inside .srr-content, so
		// they cannot collide with reader chrome; the reader additionally refuses
		// the "srr-" prefix, which is the one thing this side cannot know about.
		policy.AllowAttrs("id").Matching(reElementID).Globally()
		policy.AllowAttrs("open").Matching(boolAttr("open")).OnElements("details")
		policy.AllowAttrs("cite").OnElements("blockquote")
		policy.AllowAttrs("href").OnElements("a")
		policy.AllowAttrs("name").Matching(reMapName).OnElements("map")
		policy.AllowAttrs("alt").Matching(bluemonday.Paragraph).OnElements("area")
		policy.AllowAttrs("coords").Matching(reAreaCoords).OnElements("area")
		policy.AllowAttrs("href").OnElements("area")
		policy.AllowAttrs("rel").Matching(bluemonday.SpaceSeparatedTokens).OnElements("area")
		policy.AllowAttrs("shape").Matching(reAreaShape).OnElements("area")
		policy.AllowAttrs("usemap").Matching(reUsemap).OnElements("img")
		policy.AllowAttrs("cite").OnElements("q")
		policy.AllowAttrs("datetime").Matching(bluemonday.ISO8601).OnElements("time")
		policy.AllowAttrs("dir").Matching(bluemonday.Direction).OnElements("bdi", "bdo")
		policy.AllowAttrs("cite").Matching(bluemonday.Paragraph).OnElements("del", "ins")
		policy.AllowAttrs("datetime").Matching(bluemonday.ISO8601).OnElements("del", "ins")
		policy.AllowAttrs("value", "min", "max", "low", "high", "optimum").Matching(bluemonday.Number).OnElements("meter")
		policy.AllowAttrs("value", "max").Matching(bluemonday.Number).OnElements("progress")

		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			i.Content = policy.Sanitize(i.Content)
			return nil
		}
	})
}
