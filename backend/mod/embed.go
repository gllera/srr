package mod

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// #embed — third-party media embeds survive as links instead of vanishing.
//
// #sanitize deletes <iframe> wholesale, so a post built around a YouTube or
// Vimeo embed publishes with its whole point silently missing. This step
// rewrites iframes of known providers into sanitizer-survivable markup
// first: the provider's derivable thumbnail wrapped in a link to the watch
// page (YouTube, Dailymotion), or a plain labelled link when no thumbnail
// URL can be derived (Vimeo, Spotify). The iframe's title attribute becomes
// the link label when present. A text link always accompanies a thumbnail —
// the thumbnail may 404 and the frontend collapses broken images, so the
// target stays reachable either way.
//
// Unknown iframes are left untouched (the sanitizer removes them as before):
// converting arbitrary embeds — ad frames included — into links would add
// junk, not readability.
//
// Takes no parameters. Pure CPU, never fails an item: unparseable content
// passes through untouched, an untouched item returns verbatim (no
// re-render). Place it BEFORE #sanitize (e.g. ["#embed", "#default"]) —
// after it there are no iframes left to convert. Composes with #selfhost,
// which will self-host the injected thumbnail like any other image.

func init() {
	Register("embed", func() Processor {
		return func(_ context.Context, p Params, i *RawItem) error {
			if err := p.only(); err != nil {
				return err
			}
			i.Content = embedContent(i.Content)
			return nil
		}
	})
}

var (
	embedIDRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{4,}$`)
	embedDigitsRe = regexp.MustCompile(`^[0-9]+$`)
)

// embedTarget is the link a recognized iframe collapses to.
type embedTarget struct {
	link  string
	thumb string // empty when the provider has no derivable thumbnail URL
	label string // fallback label when the iframe carries no title
}

// embedContent replaces known-provider iframes in content. Returns content
// verbatim when nothing changed (or nothing parsed).
func embedContent(content string) string {
	if !strings.Contains(strings.ToLower(content), "<iframe") {
		return content
	}
	body := parseBodyHTML(content)
	if body == nil {
		return content
	}

	var frames []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "iframe" {
			frames = append(frames, n)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(body)

	changed := false
	for _, f := range frames {
		t, ok := classifyEmbed(mediaAttr(f, "src"))
		if !ok {
			continue
		}
		label := strings.TrimSpace(mediaAttr(f, "title"))
		if label == "" {
			label = t.label
		}
		f.Parent.InsertBefore(embedReplacement(t, label), f)
		f.Parent.RemoveChild(f)
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

// classifyEmbed maps a known provider's embed URL to its watch-page target.
func classifyEmbed(src string) (embedTarget, bool) {
	s := strings.TrimSpace(src)
	if strings.HasPrefix(s, "//") {
		s = "https:" + s
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return embedTarget{}, false
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(host, "www.")
	host = strings.TrimPrefix(host, "m.")
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")

	switch host {
	case "youtube.com", "youtube-nocookie.com":
		// /embed/videoseries is a playlist, not a video — no watch URL to map.
		if len(parts) >= 2 && (parts[0] == "embed" || parts[0] == "shorts") &&
			parts[1] != "videoseries" && embedIDRe.MatchString(parts[1]) {
			return embedTarget{
				link:  "https://www.youtube.com/watch?v=" + parts[1],
				thumb: "https://i.ytimg.com/vi/" + parts[1] + "/hqdefault.jpg",
				label: "Watch on YouTube",
			}, true
		}
	case "player.vimeo.com":
		if len(parts) >= 2 && parts[0] == "video" && embedDigitsRe.MatchString(parts[1]) {
			return embedTarget{
				link:  "https://vimeo.com/" + parts[1],
				label: "Watch on Vimeo",
			}, true
		}
	case "dailymotion.com", "geo.dailymotion.com":
		id := u.Query().Get("video") // geo player: /player.html?video=<id>
		if len(parts) >= 3 && parts[0] == "embed" && parts[1] == "video" {
			id = parts[2]
		}
		if embedIDRe.MatchString(id) {
			return embedTarget{
				link:  "https://www.dailymotion.com/video/" + id,
				thumb: "https://www.dailymotion.com/thumbnail/video/" + id,
				label: "Watch on Dailymotion",
			}, true
		}
	case "open.spotify.com":
		if len(parts) >= 3 && parts[0] == "embed" {
			return embedTarget{
				link:  "https://open.spotify.com/" + strings.Join(parts[1:], "/"),
				label: "Listen on Spotify",
			}, true
		}
	}
	return embedTarget{}, false
}

// embedReplacement builds the <p> that stands in for the iframe: optional
// linked thumbnail, then a labelled text link. html.Render escapes values.
func embedReplacement(t embedTarget, label string) *html.Node {
	p := &html.Node{Type: html.ElementNode, Data: "p", DataAtom: atom.P}
	if t.thumb != "" {
		a := embedAnchor(t.link)
		a.AppendChild(&html.Node{Type: html.ElementNode, Data: "img", DataAtom: atom.Img,
			Attr: []html.Attribute{{Key: "src", Val: t.thumb}, {Key: "alt", Val: label}}})
		p.AppendChild(a)
		p.AppendChild(&html.Node{Type: html.ElementNode, Data: "br", DataAtom: atom.Br})
	}
	a := embedAnchor(t.link)
	a.AppendChild(&html.Node{Type: html.TextNode, Data: "▶ " + label})
	p.AppendChild(a)
	return p
}

func embedAnchor(link string) *html.Node {
	return &html.Node{Type: html.ElementNode, Data: "a", DataAtom: atom.A,
		Attr: []html.Attribute{{Key: "href", Val: link}}}
}
