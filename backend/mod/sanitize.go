package mod

import (
	"context"
	"regexp"

	"github.com/microcosm-cc/bluemonday"
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
		policy.AllowAttrs("poster").Matching(regexp.MustCompile(`(?i)^(https?://|assets/)`)).OnElements("video")
		policy.AllowAttrs("preload").Matching(regexp.MustCompile(`(?i)^(none|metadata|auto)$`)).OnElements("video")
		policy.AllowAttrs("controls").Matching(regexp.MustCompile(`(?i)^(|controls)$`)).OnElements("video")
		policy.AllowAttrs("playsinline").Matching(regexp.MustCompile(`(?i)^(|playsinline)$`)).OnElements("video")
		// GIF-style playback: srr-x (v1.4) rebuilds GIF tweets as muted looping
		// autoplaying video — the way every platform renders GIFs. Autoplay is
		// only honored by browsers when muted, so the trio is emitted together.
		policy.AllowAttrs("autoplay").Matching(regexp.MustCompile(`(?i)^(|autoplay)$`)).OnElements("video")
		policy.AllowAttrs("muted").Matching(regexp.MustCompile(`(?i)^(|muted)$`)).OnElements("video")
		policy.AllowAttrs("loop").Matching(regexp.MustCompile(`(?i)^(|loop)$`)).OnElements("video")
		policy.AllowAttrs("width", "height").Matching(bluemonday.NumberOrPercent).OnElements("video")
		policy.AllowElements("video")

		// <audio> mirrors <video> minus the visual/poster attrs. bluemonday
		// URL-scheme-validates "src" like it does for video/img. controls and
		// preload are constrained to their valid token sets. #selfhost runs after
		// #sanitize, so <audio> must survive here for its media to be self-hosted;
		// the frontend (fmt.ts) forces controls so a control-less feed <audio>
		// still renders a player.
		policy.AllowAttrs("src").OnElements("audio")
		policy.AllowAttrs("preload").Matching(regexp.MustCompile(`(?i)^(none|metadata|auto)$`)).OnElements("audio")
		policy.AllowAttrs("controls").Matching(regexp.MustCompile(`(?i)^(|controls)$`)).OnElements("audio")
		policy.AllowElements("audio")

		policy.RequireParseableURLs(true)
		policy.AllowRelativeURLs(true)
		policy.AllowURLSchemes("mailto", "http", "https")

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
		policy.AllowAttrs("lang").Matching(regexp.MustCompile(`[a-zA-Z]{2,20}`)).Globally()
		policy.AllowAttrs("open").Matching(regexp.MustCompile(`(?i)^(|open)$`)).OnElements("details")
		policy.AllowAttrs("cite").OnElements("blockquote")
		policy.AllowAttrs("href").OnElements("a")
		policy.AllowAttrs("name").Matching(regexp.MustCompile(`^([\p{L}\p{N}_-]+)$`)).OnElements("map")
		policy.AllowAttrs("alt").Matching(bluemonday.Paragraph).OnElements("area")
		policy.AllowAttrs("coords").Matching(regexp.MustCompile(`^([0-9]+,)+[0-9]+$`)).OnElements("area")
		policy.AllowAttrs("href").OnElements("area")
		policy.AllowAttrs("rel").Matching(bluemonday.SpaceSeparatedTokens).OnElements("area")
		policy.AllowAttrs("shape").Matching(regexp.MustCompile(`(?i)^(default|circle|rect|poly)$`)).OnElements("area")
		policy.AllowAttrs("usemap").Matching(regexp.MustCompile(`(?i)^#[\p{L}\p{N}_-]+$`)).OnElements("img")
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
