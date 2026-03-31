package mod

import (
	"regexp"

	"github.com/microcosm-cc/bluemonday"
)

func init() {
	Register("sanitize", func() func(*RawItem) error {
		policy := bluemonday.StrictPolicy()

		policy.AllowLists()
		policy.AllowTables()
		policy.AllowImages()

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

		return func(i *RawItem) error {
			i.Content = policy.Sanitize(i.Content)
			return nil
		}
	})
}
