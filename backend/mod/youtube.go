package mod

import (
	"context"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"strings"
)

// YouTube video IDs are 11 chars from the URL-safe base64 alphabet.
var youtubeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// Linkifier for plain-text URLs in descriptions.
var youtubeURLRe = regexp.MustCompile(`https?://[^\s<>"']+`)

func init() {
	Register("youtube", func(assets Assets) func(context.Context, *RawItem) error {
		return func(ctx context.Context, i *RawItem) error {
			id := extractYouTubeID(i.Link)
			if id == "" {
				return nil
			}
			authorName, authorURL := youtubeAuthor(i)
			i.Content = renderYouTubeContent(id, i.Title, youtubeDescription(i), authorName, authorURL)
			// Self-host the i.ytimg.com thumbnail (and any media in the
			// description) when a store is wired; no-op when assets == nil.
			content, err := RewriteMedia(ctx, assets, i.Content)
			if err != nil {
				return err
			}
			i.Content = content
			return nil
		}
	})
}

// youtubeAuthor pulls the channel display name and channel URL from the
// Atom <author> element of the entry. YouTube's feed nests <name> and <uri>
// children inside <author>; the <uri> already points at /channel/<id>, so we
// don't reconstruct from <yt:channelId>. Returns "" for fields that are
// absent (no <author>, malformed Raw, or one of the two children missing).
func youtubeAuthor(i *RawItem) (string, string) {
	raw, ok := i.Raw.(RawFeedItem)
	if !ok {
		return "", ""
	}
	authors := raw["author"]
	if len(authors) == 0 {
		return "", ""
	}
	a := authors[0].Chld
	return a.Text("name"), a.Text("uri")
}

// extractYouTubeID returns the canonical 11-char video ID for any YouTube
// link form (watch?v=, youtu.be/, /embed/, /v/, /shorts/) or "" if the link
// is not a recognised YouTube video URL.
func extractYouTubeID(link string) string {
	if link == "" {
		return ""
	}
	u, err := url.Parse(link)
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")

	var candidate string
	switch host {
	case "youtu.be":
		candidate = strings.TrimPrefix(u.Path, "/")
	case "youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com":
		if v := u.Query().Get("v"); v != "" {
			candidate = v
		} else {
			for _, prefix := range []string{"/embed/", "/v/", "/shorts/", "/live/"} {
				if rest, ok := strings.CutPrefix(u.Path, prefix); ok {
					candidate = rest
					break
				}
			}
		}
	default:
		return ""
	}

	if i := strings.IndexByte(candidate, '/'); i >= 0 {
		candidate = candidate[:i]
	}
	if !youtubeIDRe.MatchString(candidate) {
		return ""
	}
	return candidate
}

// youtubeDescription pulls the <media:description> text from inside
// <media:group>, falling back to the entry-level description and finally
// to the existing Content. Empty if none is present.
func youtubeDescription(i *RawItem) string {
	raw, ok := i.Raw.(RawFeedItem)
	if !ok {
		return i.Content
	}
	if g, ok := raw["group"]; ok {
		for _, f := range g {
			if d := f.Chld.Text("description"); d != "" {
				return d
			}
		}
	}
	if d := raw.Text("description", "summary"); d != "" {
		return d
	}
	return i.Content
}

func renderYouTubeContent(id, title, description, authorName, authorURL string) string {
	var b strings.Builder
	if authorName != "" {
		if authorURL != "" {
			fmt.Fprintf(&b, `<p>by <a href="%s">%s</a></p>`,
				html.EscapeString(authorURL),
				html.EscapeString(authorName),
			)
		} else {
			fmt.Fprintf(&b, `<p>by %s</p>`, html.EscapeString(authorName))
		}
	}
	watchURL := "https://www.youtube.com/watch?v=" + id
	thumbURL := "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"
	fmt.Fprintf(&b, `<p><a href="%s"><img src="%s" alt="%s"></a></p>`,
		html.EscapeString(watchURL),
		html.EscapeString(thumbURL),
		html.EscapeString(title),
	)
	if desc := strings.TrimSpace(description); desc != "" {
		b.WriteString(renderDescription(desc))
	}
	return b.String()
}

// renderDescription escapes HTML, auto-links bare URLs, and converts
// blank-line-separated blocks into <p> with single newlines as <br>.
func renderDescription(desc string) string {
	desc = strings.ReplaceAll(desc, "\r\n", "\n")
	desc = strings.ReplaceAll(desc, "\r", "\n")

	var b strings.Builder
	for block := range strings.SplitSeq(desc, "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		b.WriteString("<p>")
		first := true
		for line := range strings.SplitSeq(block, "\n") {
			if !first {
				b.WriteString("<br>")
			}
			first = false
			b.WriteString(linkifyEscape(line))
		}
		b.WriteString("</p>")
	}
	return b.String()
}

func linkifyEscape(s string) string {
	matches := youtubeURLRe.FindAllStringIndex(s, -1)
	if len(matches) == 0 {
		return html.EscapeString(s)
	}
	var b strings.Builder
	last := 0
	for _, m := range matches {
		b.WriteString(html.EscapeString(s[last:m[0]]))
		raw := s[m[0]:m[1]]
		// trim trailing punctuation that's almost never part of a URL
		raw = strings.TrimRight(raw, ".,;:!?)]}>")
		end := m[0] + len(raw)
		esc := html.EscapeString(raw)
		fmt.Fprintf(&b, `<a href="%s">%s</a>`, esc, esc)
		last = end
	}
	b.WriteString(html.EscapeString(s[last:]))
	return b.String()
}
