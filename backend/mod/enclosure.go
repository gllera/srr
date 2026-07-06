package mod

import (
	"context"
	"net/url"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// #enclosure — surface media that rides outside the article body.
//
// Many feeds carry their only image or player payload in item metadata the
// body never mentions: an RSS <enclosure> (podcasts), an Atom
// <link rel="enclosure">, Media RSS <media:content>/<media:thumbnail>
// (directly or inside <media:group> — YouTube's layout), or an
// <itunes:image>. The pipeline works on Content, so those articles render
// as bare text. This step reads the parsed feed entry (RawItem.Raw) and
// prepends the missing media to the content: the best image (largest
// declared full image, thumbnails only as fallback), the first video, and
// the first audio, each in its own <p> — <video>/<audio> with controls.
//
// A candidate already visible in the body is skipped: exact URL containment,
// plus the same file-identity normalization #dedupmedia uses (a WordPress
// size variant of the enclosure image counts as present). Candidates
// without a usable kind (MIME type, medium attribute, or URL extension) or
// a non-http(s) URL are ignored — YouTube's x-shockwave-flash content entry
// falls out here while its thumbnail survives.
//
// Takes no parameters. No-ops on items without a parsed feed entry (external
// ingest strategies). Pure CPU, never fails an item; an untouched item
// returns verbatim. Place it BEFORE #sanitize and #dedupmedia (e.g.
// ["#enclosure", "#dedupmedia", "#default"]) so the injected media is
// clamped and cross-checked like body media.

func init() {
	Register("enclosure", func() Processor {
		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			raw, ok := i.Raw.(RawFeedItem)
			if !ok {
				return nil
			}
			i.Content = prependEnclosures(raw, i.Content)
			return nil
		}
	})
}

// enclosureCand is one out-of-body media reference found in the feed entry.
type enclosureCand struct {
	url   string
	kind  string // "image", "audio", "video"
	area  int    // declared width*height — image ranking
	thumb bool   // media:thumbnail / itunes:image — image fallback tier
}

// enclosureExtKinds classifies a candidate by URL extension when the entry
// declares no usable MIME type or medium.
var enclosureExtKinds = map[string]string{
	"jpg": "image", "jpeg": "image", "png": "image", "gif": "image", "webp": "image", "avif": "image",
	"mp3": "audio", "m4a": "audio", "aac": "audio", "ogg": "audio", "oga": "audio", "opus": "audio", "flac": "audio", "wav": "audio",
	"mp4": "video", "m4v": "video", "webm": "video", "mov": "video",
}

// prependEnclosures prepends the entry's out-of-body media to content.
// Returns content verbatim when there is nothing new to add.
func prependEnclosures(raw RawFeedItem, content string) string {
	cands := collectEnclosureCands(raw)
	if len(cands) == 0 {
		return content
	}
	present := contentMediaIDs(content)
	fresh := func(u string) bool {
		return !strings.Contains(content, u) &&
			!strings.Contains(content, html.EscapeString(u)) &&
			!present[mediaFileID(u)]
	}

	var img, vid, aud *enclosureCand
	for idx := range cands {
		c := &cands[idx]
		if !fresh(c.url) {
			continue
		}
		switch c.kind {
		case "image":
			if img == nil || betterEnclosureImage(c, img) {
				img = c
			}
		case "video":
			if vid == nil {
				vid = c
			}
		case "audio":
			if aud == nil {
				aud = c
			}
		}
	}

	block := &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body}
	wrap := func(el *html.Node) {
		p := &html.Node{Type: html.ElementNode, Data: "p", DataAtom: atom.P}
		p.AppendChild(el)
		block.AppendChild(p)
	}
	if img != nil {
		wrap(&html.Node{Type: html.ElementNode, Data: "img", DataAtom: atom.Img,
			Attr: []html.Attribute{{Key: "src", Val: img.url}}})
	}
	if vid != nil {
		wrap(&html.Node{Type: html.ElementNode, Data: "video", DataAtom: atom.Video,
			Attr: []html.Attribute{{Key: "controls", Val: ""}, {Key: "src", Val: vid.url}}})
	}
	if aud != nil {
		wrap(&html.Node{Type: html.ElementNode, Data: "audio", DataAtom: atom.Audio,
			Attr: []html.Attribute{{Key: "controls", Val: ""}, {Key: "src", Val: aud.url}}})
	}
	if block.FirstChild == nil {
		return content
	}
	out, ok := renderBodyHTML(block)
	if !ok {
		return content
	}
	return out + content
}

// collectEnclosureCands gathers media references from every place feeds
// stash them, in document-ish order. Only http(s) URLs qualify — anything
// else would be stripped by the sanitizer anyway.
func collectEnclosureCands(raw RawFeedItem) []enclosureCand {
	var out []enclosureCand
	add := func(f RawField, thumbTier bool) {
		u := strings.TrimSpace(f.Attr["url"])
		if u == "" {
			u = strings.TrimSpace(f.Attr["href"])
		}
		lower := strings.ToLower(u)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			return
		}
		kind := enclosureKind(f.Attr["type"], f.Attr["medium"], u)
		if thumbTier {
			if kind != "" && kind != "image" {
				return
			}
			kind = "image" // a thumbnail is an image by definition
		}
		if kind == "" {
			return
		}
		out = append(out, enclosureCand{
			url:   u,
			kind:  kind,
			area:  pxDim(f.Attr["width"]) * pxDim(f.Attr["height"]),
			thumb: thumbTier,
		})
	}

	for _, f := range raw["enclosure"] { // RSS <enclosure url type>
		add(f, false)
	}
	for _, f := range raw["link"] { // Atom <link rel="enclosure" href type>
		if strings.EqualFold(strings.TrimSpace(f.Attr["rel"]), "enclosure") {
			add(f, false)
		}
	}
	// media:content — only url-attr-bearing entries; a text <content> body
	// element shares the local name but never carries url.
	for _, f := range raw["content"] {
		if f.Attr["url"] != "" {
			add(f, false)
		}
	}
	for _, g := range raw["group"] { // <media:group> (YouTube's layout)
		for _, f := range g.Chld["content"] {
			if f.Attr["url"] != "" {
				add(f, false)
			}
		}
		for _, f := range g.Chld["thumbnail"] {
			add(f, true)
		}
	}
	for _, f := range raw["thumbnail"] { // <media:thumbnail url>
		add(f, true)
	}
	for _, f := range raw["image"] { // <itunes:image href>
		if f.Attr["href"] != "" {
			add(f, true)
		}
	}
	return out
}

// enclosureKind classifies a candidate: MIME type prefix first, then the
// Media RSS medium attribute, then the URL extension. An undeclarable kind
// ("" — e.g. application/x-shockwave-flash) is skipped by the caller.
func enclosureKind(typ, medium, u string) string {
	typ = strings.ToLower(strings.TrimSpace(typ))
	for _, k := range []string{"image", "audio", "video"} {
		if strings.HasPrefix(typ, k+"/") {
			return k
		}
	}
	if typ != "" && typ != "application/octet-stream" {
		return ""
	}
	switch strings.ToLower(strings.TrimSpace(medium)) {
	case "image", "audio", "video":
		return strings.ToLower(strings.TrimSpace(medium))
	}
	if uu, err := url.Parse(u); err == nil {
		if i := strings.LastIndex(uu.Path, "."); i >= 0 {
			return enclosureExtKinds[strings.ToLower(uu.Path[i+1:])]
		}
	}
	return ""
}

// betterEnclosureImage reports whether a beats b: a full image beats a
// thumbnail, then larger declared area; earlier candidates win ties.
func betterEnclosureImage(a, b *enclosureCand) bool {
	if a.thumb != b.thumb {
		return !a.thumb
	}
	return a.area > b.area
}

// contentMediaIDs collects the file identities of media already visible in
// the body, keyed like #dedupmedia's groups.
func contentMediaIDs(content string) map[string]bool {
	ids := map[string]bool{}
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "<img") && !strings.Contains(lower, "<video") &&
		!strings.Contains(lower, "<audio") {
		return ids
	}
	body := parseBodyHTML(content)
	if body == nil {
		return ids
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && dedupMediaTags[n.Data] {
			if src := strings.TrimSpace(mediaAttr(n, "src")); src != "" {
				ids[mediaFileID(src)] = true
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(body)
	return ids
}
