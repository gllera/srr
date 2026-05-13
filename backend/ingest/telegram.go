package ingest

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"srrb/mod"
)

// "#telegram" scrapes a public Telegram channel preview page
// (https://t.me/s/<channel>) into RawItems — one per visible message.
// Telegram returns no useful ETag/Last-Modified for these pages, so the
// fetcher returns every visible message every time and relies on the
// caller's source-level GUID dedup to suppress re-presented messages.
// The GUID is `<channel>/<id>` (stable per Telegram message).
func init() {
	Register("telegram", func() FetchFunc {
		return func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error) {
			if err := validateTelegramURL(req.URL); err != nil {
				return Result{}, err
			}

			httpReq, err := http.NewRequestWithContext(ctx, "GET", req.URL, nil)
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

func validateTelegramURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid telegram url: %w", err)
	}
	if u.Host != "t.me" {
		return fmt.Errorf("telegram fetcher requires t.me host, got %q", u.Host)
	}
	if !strings.HasPrefix(u.Path, "/s/") || len(strings.TrimPrefix(u.Path, "/s/")) == 0 {
		return fmt.Errorf("telegram fetcher requires /s/<channel> path, got %q", u.Path)
	}
	return nil
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
