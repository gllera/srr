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
// URL can be derived (Vimeo, Spotify, TikTok, Twitch, SoundCloud,
// Streamable, Bandcamp). The iframe's title attribute becomes the link
// label when present. A text link always accompanies a thumbnail — the
// thumbnail may 404 and the frontend collapses broken images, so the target
// stays reachable either way.
//
// TikTok and Bandcamp are the two providers whose link is the normalized
// PLAYER page rather than a watch page: their embed URLs carry no author or
// artist, so no watch page is derivable from them — see embedTikTok and
// embedBandcamp.
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
	RegisterDOM("embed", func() DOMProcessor {
		return func(_ context.Context, p Params, _ *RawItem, body *html.Node) (bool, error) {
			if err := p.only(); err != nil {
				return false, err
			}
			return embedContent(body), nil
		}
	})
}

var (
	embedIDRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{4,}$`)
	embedDigitsRe = regexp.MustCompile(`^[0-9]+$`)
	// A Twitch login is its own grammar, narrower than embedIDRe (no dashes)
	// and length-bounded — it is interpolated into a bare twitch.tv/<name>.
	embedTwitchLoginRe = regexp.MustCompile(`^[A-Za-z0-9_]{3,25}$`)
)

// embedTarget is the link a recognized iframe collapses to.
type embedTarget struct {
	link  string
	thumb string // empty when the provider has no derivable thumbnail URL
	label string // fallback label when the iframe carries no title
}

// embedContent replaces known-provider iframes in the content DOM, reporting
// whether it changed anything — false leaves the session's content string
// untouched.
func embedContent(body *html.Node) bool {
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
	return changed
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
	case "streamable.com":
		// /e/<id>, /o/<id> and /s/<id> are the three player paths; the watch
		// page is the same id at the root.
		if len(parts) >= 2 && (parts[0] == "e" || parts[0] == "o" || parts[0] == "s") &&
			embedIDRe.MatchString(parts[1]) {
			return embedTarget{
				link:  "https://streamable.com/" + parts[1],
				label: "Watch on Streamable",
			}, true
		}
	case "tiktok.com":
		return embedTikTok(parts)
	case "player.twitch.tv", "clips.twitch.tv":
		return embedTwitch(host, parts, u.Query())
	case "w.soundcloud.com":
		return embedSoundCloud(parts, u.Query())
	case "bandcamp.com":
		return embedBandcamp(parts)
	}
	return embedTarget{}, false
}

// embedTikTok maps a TikTok player iframe. This is one of the two providers
// (Bandcamp is the other) whose link is the PLAYER page rather than a watch
// page, and for the same reason on both: the canonical
// tiktok.com/@<author>/video/<id> URL needs the author handle and the embed
// URL does not carry it, so the target is the normalized player page — which
// is itself a real, playable page.
func embedTikTok(parts []string) (embedTarget, bool) {
	var id string
	switch {
	case len(parts) >= 3 && parts[0] == "embed" && parts[1] == "v2": // /embed/v2/<id>
		id = parts[2]
	case len(parts) >= 3 && parts[0] == "player" && parts[1] == "v1": // /player/v1/<id>
		id = parts[2]
	case len(parts) >= 2 && parts[0] == "embed": // /embed/<id>
		id = parts[1]
	}
	if !embedDigitsRe.MatchString(id) {
		return embedTarget{}, false
	}
	return embedTarget{
		link:  "https://www.tiktok.com/embed/v2/" + id,
		label: "Watch on TikTok",
	}, true
}

// embedTwitch maps the two Twitch player hosts: a VOD or a live channel on
// player.twitch.tv, a clip on clips.twitch.tv. A `collection=` player plays
// several videos in sequence and so has no single target — it stays
// unrecognized rather than linking an arbitrary member.
func embedTwitch(host string, parts []string, q url.Values) (embedTarget, bool) {
	var link string
	switch {
	case host == "clips.twitch.tv":
		// /embed?clip=<slug>; a clip's page is that slug on the same host.
		if len(parts) > 0 && parts[0] == "embed" && embedIDRe.MatchString(q.Get("clip")) {
			link = "https://clips.twitch.tv/" + q.Get("clip")
		}
	case q.Get("video") != "":
		// VOD ids appear both bare (123456) and v-prefixed (v123456).
		if id := strings.TrimPrefix(q.Get("video"), "v"); embedDigitsRe.MatchString(id) {
			link = "https://www.twitch.tv/videos/" + id
		}
	case embedTwitchLoginRe.MatchString(q.Get("channel")):
		link = "https://www.twitch.tv/" + q.Get("channel")
	}
	if link == "" {
		return embedTarget{}, false
	}
	return embedTarget{link: link, label: "Watch on Twitch"}, true
}

// embedSoundCloud maps the SoundCloud widget, whose track rides the `url`
// query param. Only a public soundcloud.com page is derivable: the widget is
// just as often pointed at api.soundcloud.com/tracks/<id>, which needs an API
// call to resolve to a page, so those stay unrecognized. The link is the
// RE-SERIALIZED parsed URL — the raw param is attacker-supplied text and this
// value is rendered as an href.
func embedSoundCloud(parts []string, q url.Values) (embedTarget, bool) {
	if len(parts) == 0 || parts[0] != "player" {
		return embedTarget{}, false
	}
	t, err := url.Parse(q.Get("url"))
	if err != nil || (t.Scheme != "http" && t.Scheme != "https") {
		return embedTarget{}, false
	}
	if strings.TrimPrefix(strings.ToLower(t.Hostname()), "www.") != "soundcloud.com" {
		return embedTarget{}, false
	}
	return embedTarget{link: t.String(), label: "Listen on SoundCloud"}, true
}

// embedBandcamp maps the Bandcamp player, whose path is a run of key=value
// segments (EmbeddedPlayer/album=123456/size=large/…). Like TikTok it names
// no artist, so no album or track page is derivable from it and the link is
// the normalized player page for the id it does carry.
func embedBandcamp(parts []string) (embedTarget, bool) {
	if len(parts) == 0 || parts[0] != "EmbeddedPlayer" {
		return embedTarget{}, false
	}
	for _, seg := range parts[1:] {
		k, v, ok := strings.Cut(seg, "=")
		if !ok || (k != "album" && k != "track") || !embedDigitsRe.MatchString(v) {
			continue
		}
		return embedTarget{
			link:  "https://bandcamp.com/EmbeddedPlayer/" + k + "=" + v + "/",
			label: "Listen on Bandcamp",
		}, true
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
