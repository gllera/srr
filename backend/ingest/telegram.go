package ingest

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/html"

	"srrb/mod"
)

// "#telegram" scrapes a public Telegram channel preview page
// (https://t.me/s/<channel>) into RawItems — one per visible message.
// The user-facing channel URL form (https://t.me/<channel>) is also
// accepted and rewritten internally to the /s/ preview page.
// Telegram returns no useful ETag/Last-Modified for these pages, so the
// fetcher returns every visible message every time and relies on the
// caller's source-level GUID dedup to suppress re-presented messages.
// The GUID is `<channel>/<id>` (stable per Telegram message).
func init() {
	Register("telegram", func() FetchFunc {
		return func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error) {
			fetchURL, err := telegramPreviewURL(req.URL)
			if err != nil {
				return Result{}, err
			}

			httpReq, err := http.NewRequestWithContext(ctx, "GET", fetchURL, nil)
			if err != nil {
				return Result{}, err
			}
			httpReq.Header.Set("User-Agent", userAgent)

			res, err := client.Do(httpReq)
			if err != nil {
				return Result{}, err
			}
			defer res.Body.Close()

			if res.StatusCode != http.StatusOK {
				return Result{}, fmt.Errorf("unexpected HTTP status: %s", res.Status)
			}

			data, err := readBody(res.Body, buf, "telegram page")
			if err != nil {
				return Result{}, err
			}

			items, err := parseTelegramHTML(data)
			if err != nil {
				return Result{}, err
			}

			return Result{Items: items}, nil
		}
	})
}

// telegramPreviewURL validates that raw points to a public Telegram
// channel and returns the /s/<channel> preview URL the fetcher consumes.
// Accepted inputs:
//   - https://t.me/s/<channel>  (used as-is)
//   - https://t.me/<channel>    (rewritten to /s/<channel>)
//
// Deep links to a specific message (/<channel>/<id>), invite links
// (/+<token>, /joinchat/<token>) and private channel references
// (/c/<id>/...) are rejected — they don't expose a preview page.
func telegramPreviewURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid telegram url: %w", err)
	}
	if u.Host != "t.me" {
		return "", fmt.Errorf("telegram fetcher requires t.me host, got %q", u.Host)
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	var channel string
	switch {
	case len(parts) == 2 && parts[0] == "s" && parts[1] != "":
		channel = parts[1]
	case len(parts) == 1 && parts[0] != "" && parts[0] != "s" &&
		!strings.HasPrefix(parts[0], "+"):
		channel = parts[0]
	default:
		return "", fmt.Errorf("telegram fetcher requires /<channel> or /s/<channel> path, got %q", u.Path)
	}
	u.Path = "/s/" + channel
	return u.String(), nil
}

// parseTelegramHTML walks the document looking for tgme_widget_message
// containers and pulls (post permalink, datetime, message HTML) out of
// each. Returning errors for missing fields would be too strict: pinned
// banners and service-event nodes share the prefix but lack a body.
// Such nodes are silently skipped.
func parseTelegramHTML(data []byte) ([]*mod.RawItem, error) {
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse telegram html: %w", err)
	}

	channelTitle := findChannelTitle(doc)

	var items []*mod.RawItem
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "div" && hasClass(n, "tgme_widget_message") {
			if item := extractTelegramMessage(n, channelTitle); item != nil {
				items = append(items, item)
			}
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return items, nil
}

func extractTelegramMessage(msg *html.Node, channelTitle string) *mod.RawItem {
	post := attr(msg, "data-post")
	if post == "" {
		return nil
	}
	link := "https://t.me/" + post

	title := channelTitle
	if title == "" {
		// Fallback: the channel handle from data-post ("channel/id" → "channel").
		// Defensive; preview pages we validate via /s/<channel> normally carry
		// the header title.
		if i := strings.IndexByte(post, '/'); i > 0 {
			title = post[:i]
		}
	}

	var pub *time.Time
	var content strings.Builder

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch {
			case n.Data == "a" && hasClass(n, "tgme_widget_message_photo_wrap"):
				writeTelegramPhoto(&content, n)
				return
			case n.Data == "a" && (hasClass(n, "tgme_widget_message_video_player") ||
				hasClass(n, "tgme_widget_message_roundvideo")):
				writeTelegramVideo(&content, n, link)
				return
			case n.Data == "div" && hasClass(n, "tgme_widget_message_text"):
				renderHTML(&content, n)
				return
			case n.Data == "a" && hasClass(n, "tgme_widget_message_date"):
				// The publish <time> lives inside the date anchor; a
				// video-duration <time> elsewhere in the bubble must
				// not be mistaken for it.
				if t := findTimeDatetime(n); t != nil {
					pub = t
				}
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(msg)

	if content.Len() == 0 && pub == nil {
		return nil
	}

	return &mod.RawItem{
		GUID:      hash(post),
		Title:     title,
		Content:   strings.TrimSpace(content.String()),
		Link:      link,
		Published: pub,
	}
}

// findChannelTitle locates the channel display name in the preview-page
// header (div.tgme_channel_info_header_title). Returns "" if absent.
func findChannelTitle(n *html.Node) string {
	if n.Type == html.ElementNode && n.Data == "div" && hasClass(n, "tgme_channel_info_header_title") {
		return strings.TrimSpace(textContent(n))
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if t := findChannelTitle(c); t != "" {
			return t
		}
	}
	return ""
}

func textContent(n *html.Node) string {
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

func findTimeDatetime(n *html.Node) *time.Time {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "time" {
			if dt := attr(c, "datetime"); dt != "" {
				if t, err := time.Parse(time.RFC3339, dt); err == nil {
					t = t.UTC()
					return &t
				}
			}
		}
		if t := findTimeDatetime(c); t != nil {
			return t
		}
	}
	return nil
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func hasClass(n *html.Node, cls string) bool {
	for c := range strings.FieldsSeq(attr(n, "class")) {
		if c == cls {
			return true
		}
	}
	return false
}

// renderHTML serialises an element's inner HTML into the builder. Used
// to preserve message formatting (links, line breaks, bold) — the
// sanitize pipeline module is the right place to lock the allowlist
// down later.
func renderHTML(out *strings.Builder, n *html.Node) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		_ = html.Render(out, c)
	}
}

// writeTelegramPhoto emits an <img> linked to the full-size source. The
// URL is either inside a nested <img src="…"> or inline on the wrapper's
// "background-image:url(…)" style — both forms are seen in production.
func writeTelegramPhoto(out *strings.Builder, n *html.Node) {
	url := findImgSrc(n)
	if url == "" {
		url = findStyleBgImage(n)
	}
	if url == "" {
		return
	}
	esc := html.EscapeString(url)
	fmt.Fprintf(out, `<p><a href="%s"><img src="%s"></a></p>`, esc, esc)
}

// writeTelegramVideo emits an inline <video> player when a direct
// <video src> is available so the user can play in-place. Falls back to
// a clickable thumbnail card linking to the message permalink when only
// a thumbnail is present (some bubbles ship preview-only). Thumbnail
// comes from the inline background-image style on
// .tgme_widget_message_video_thumb (or any descendant style). When the
// wrapper carries the padding-top% aspect-ratio hint, that ratio is
// propagated as width/height attributes so the element starts at
// hint-derived dimensions — without them the browser falls back to the
// 320×180 poster size until mp4 metadata loads on first play.
func writeTelegramVideo(out *strings.Builder, n *html.Node, messageLink string) {
	videoSrc := findVideoSrc(n)
	thumb := findStyleBgImage(n)
	if videoSrc != "" {
		out.WriteString("<p><video ")
		fmt.Fprintf(out, `src="%s"`, html.EscapeString(videoSrc))
		if thumb != "" {
			fmt.Fprintf(out, ` poster="%s"`, html.EscapeString(thumb))
		}
		if w, h := videoAspect(n); w > 0 && h > 0 {
			fmt.Fprintf(out, ` width="%d" height="%d"`, w, h)
		}
		out.WriteString(` controls preload="metadata" playsinline></video></p>`)
		return
	}
	if thumb != "" {
		fmt.Fprintf(out, `<p><a href="%s"><img src="%s"></a></p>`,
			html.EscapeString(messageLink), html.EscapeString(thumb))
	}
}

// videoAspect derives a width/height integer pair from the wrapper's
// inline padding-top% (height/width × 100, the CSS aspect-ratio trick).
// Returns 0,0 when no padding-top is present or parseable. The pair is
// scaled to 1000:N so the integer ratio carries ~0.1% precision.
func videoAspect(n *html.Node) (int, int) {
	pct := findStylePaddingTop(n)
	if pct <= 0 {
		return 0, 0
	}
	const baseWidth = 1000
	height := int(pct*10 + 0.5)
	if height < 1 {
		return 0, 0
	}
	return baseWidth, height
}

// findStylePaddingTop walks n and its descendants for the first inline
// "style" attribute containing a "padding-top:NN%" declaration, returning
// NN as a float, or 0 if missing/unparseable.
func findStylePaddingTop(n *html.Node) float64 {
	if n.Type == html.ElementNode {
		if pct := parsePaddingTopPercent(attr(n, "style")); pct > 0 {
			return pct
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if pct := findStylePaddingTop(c); pct > 0 {
			return pct
		}
	}
	return 0
}

// parsePaddingTopPercent extracts NN from "padding-top: NN%" in a style
// string. Returns 0 if missing or non-percentage.
func parsePaddingTopPercent(style string) float64 {
	_, rest, ok := strings.Cut(style, "padding-top")
	if !ok {
		return 0
	}
	rest = strings.TrimLeft(rest, ": \t")
	end := strings.IndexAny(rest, "%;")
	if end < 0 || rest[end] != '%' {
		return 0
	}
	val, err := strconv.ParseFloat(strings.TrimSpace(rest[:end]), 64)
	if err != nil || val <= 0 {
		return 0
	}
	return val
}

// findImgSrc returns the src of the first <img> descendant of n, or "".
func findImgSrc(n *html.Node) string {
	if n.Type == html.ElementNode && n.Data == "img" {
		return attr(n, "src")
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if s := findImgSrc(c); s != "" {
			return s
		}
	}
	return ""
}

// findVideoSrc returns the src of the first <video> descendant of n, or "".
func findVideoSrc(n *html.Node) string {
	if n.Type == html.ElementNode && n.Data == "video" {
		return attr(n, "src")
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if s := findVideoSrc(c); s != "" {
			return s
		}
	}
	return ""
}

// findStyleBgImage walks n and its descendants for the first inline
// "style" attribute containing a "background-image:url(…)" declaration,
// returning that URL or "".
func findStyleBgImage(n *html.Node) string {
	if n.Type == html.ElementNode {
		if url := parseBgImageURL(attr(n, "style")); url != "" {
			return url
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if url := findStyleBgImage(c); url != "" {
			return url
		}
	}
	return ""
}

// parseBgImageURL extracts the URL from the first
// "background-image: url(…)" declaration in a CSS-style attribute value.
// Handles single, double, or unquoted URL forms.
func parseBgImageURL(style string) string {
	i := strings.Index(style, "background-image")
	if i < 0 {
		return ""
	}
	j := strings.Index(style[i:], "url(")
	if j < 0 {
		return ""
	}
	start := i + j + len("url(")
	end := strings.IndexByte(style[start:], ')')
	if end < 0 {
		return ""
	}
	raw := strings.TrimSpace(style[start : start+end])
	raw = strings.Trim(raw, `"'`)
	return raw
}
