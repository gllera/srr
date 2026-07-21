package ingest

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/html/charset"

	"srr/mod"
)

// "#feed" is the default zero-config fetcher: HTTP GET with If-None-Match
// / If-Modified-Since hints, streamed into the shared per-worker buffer,
// then handed to the streaming RSS/Atom/RDF parser (ParseFeed) defined
// below.
//
// When ParseFeed fails and the response looks like HTML (Content-Type text/html
// or body starts with <!doctype html / <html), discoverFeedLink is called to
// find a <link rel="alternate"> feed URL. If one is found and this is the
// first attempt, the discovered URL is fetched and parsed. On success,
// Result.ResolvedURL is set to the discovered URL so the caller can persist
// the repoint. The one-hop guard prevents infinite loops.
func init() {
	Register("feed", func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error) {
		return feedFetch(ctx, client, buf, req, false)
	})
}

// feedFetch is the implementation of the #feed FetchFunc. discovered signals
// that this call is itself a discovery retry — it must not discover again
// (one-hop guard).
func feedFetch(ctx context.Context, client *http.Client, buf []byte, req Request, discovered bool) (Result, error) {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", req.URL, nil)
	if err != nil {
		return Result{}, err
	}
	httpReq.Header.Set("User-Agent", userAgent)
	httpReq.Header.Set("Accept", acceptFeed)
	if req.ETag != "" {
		httpReq.Header.Set("If-None-Match", req.ETag)
	}
	if req.LastModified != "" {
		httpReq.Header.Set("If-Modified-Since", req.LastModified)
	}

	res, err := client.Do(httpReq)
	if err != nil {
		return Result{}, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotModified {
		slog.Debug("source not modified", "url", req.URL)
		return Result{NotModified: true}, nil
	}
	if res.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("unexpected HTTP status: %s", res.Status)
	}

	data, err := readBody(res.Body, buf, "feed")
	if err != nil {
		return Result{}, err
	}

	var items []*mod.RawItem
	feedTitle, partial, parseErr := ParseFeed(data, func(i *mod.RawItem) error {
		items = append(items, i)
		return nil
	})
	if parseErr != nil {
		// On parse failure, attempt feed auto-discovery if:
		//   1. The failure means "not a feed" (errNotFeed), not a fault parsing a
		//      recognized feed — a broken feed must never trigger discovery.
		//   2. This is not already a discovery retry (one-hop guard).
		//   3. The response body looks like HTML.
		if errors.Is(parseErr, errNotFeed) && !discovered && looksLikeHTML(res.Header.Get("Content-Type"), data) {
			if feedURL, ok := discoverFeedLink(data, req.URL); ok {
				slog.Debug("auto-discovering feed from HTML page", "html_url", req.URL, "feed_url", feedURL)
				retryReq := Request{
					URL:      feedURL,
					MaxSize:  req.MaxSize,
					AssetDir: req.AssetDir,
					// Do not forward ETag/LastModified: they belonged to the HTML
					// page, not the newly discovered feed URL.
				}
				result, err := feedFetch(ctx, client, buf, retryReq, true)
				if err != nil {
					return Result{}, err
				}
				// Record the resolved URL so the caller can persist the repoint.
				result.ResolvedURL = feedURL
				return result, nil
			}
		}
		return Result{}, parseErr
	}

	result := Result{Items: items, Title: feedTitle, Partial: partial}
	if !partial {
		// A partial parse deliberately withholds the validators: storing them
		// would let the next cycle 304 on the same broken bytes, stranding every
		// item after the malformed element until the publisher changes the feed.
		result.ETag = res.Header.Get("ETag")
		result.LastModified = res.Header.Get("Last-Modified")
	}
	return result, nil
}

// looksLikeHTML returns true when the Content-Type header is text/html or
// the body (after trimming leading whitespace/BOM) starts with <!doctype html
// or <html (case-insensitive). This is intentionally loose: a false positive
// only triggers an attempted discoverFeedLink scan, which is cheap.
func looksLikeHTML(contentType string, data []byte) bool {
	if strings.Contains(strings.ToLower(contentType), "text/html") {
		return true
	}
	// Trim leading whitespace and the UTF-8 BOM (EF BB BF).
	b := bytes.TrimSpace(data)
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	b = bytes.TrimSpace(b)
	prefix := strings.ToLower(string(b[:min(len(b), 14)]))
	return strings.HasPrefix(prefix, "<!doctype html") || strings.HasPrefix(prefix, "<html")
}

// Resolve probes rawURL via the built-in #feed fetcher and returns the URL a
// subscription should store: rawURL itself when it already serves a feed, the
// discovered <link rel=alternate> target when rawURL is an HTML page that
// advertises one, or an error when it yields neither (not a feed and no
// discoverable link, or a fetch failure). maxSize bounds the body read, sizing
// the buffer exactly as the fetch loop does (cap-1 is the real limit). Only
// meaningful for the built-in #feed strategy; callers must skip it for external
// ingest strategies, whose sources are not HTTP-fetchable feeds.
func Resolve(ctx context.Context, client *http.Client, rawURL string, maxSize int) (string, error) {
	buf := make([]byte, maxSize+1)
	res, err := feedFetch(ctx, client, buf, Request{URL: rawURL, MaxSize: maxSize}, false)
	if err != nil {
		return "", err
	}
	if res.ResolvedURL != "" {
		return res.ResolvedURL, nil
	}
	return rawURL, nil
}

// --- RSS/Atom/RDF feed parser -----------------------------------------

// hash is FNV-32a, inlined to avoid the per-call hash.Hash32 allocation
// (this runs once per parsed item across every fetch).
func hash(s string) uint32 {
	const (
		offset32 = 2166136261
		prime32  = 16777619
	)
	h := uint32(offset32)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= prime32
	}
	return h
}

var dateFields = []string{"pubDate", "published", "issued", "date", "created", "updated", "modified"}

var dateFormats = []string{
	time.RFC1123Z, time.RFC1123, time.RFC3339,
	"Mon, 2 Jan 2006 15:04:05 -0700",
	"Mon, 2 Jan 2006 15:04:05 MST",
	"2 Jan 2006 15:04:05 -0700",
	"2006-01-02T15:04:05-07:00",
	"2006-01-02",
}

// tzOffsets maps the common English-language zone abbreviations to their
// offset (seconds east of UTC). time.Parse cannot resolve an abbreviation
// without a Location: it fabricates a zero-offset zone and keeps the wall
// clock, so "15:04:05 EST" would otherwise be read as 15:04:05 UTC (5h off).
// We re-apply the offset for these known names. Abbreviations are inherently
// ambiguous (CST is US Central here, not China/Australia); unknown ones stay
// UTC, and numeric-offset forms (tried first) are always exact.
var tzOffsets = map[string]int{
	"UT": 0, "GMT": 0, "UTC": 0, "Z": 0,
	"EST": -5 * 3600, "EDT": -4 * 3600,
	"CST": -6 * 3600, "CDT": -5 * 3600,
	"MST": -7 * 3600, "MDT": -6 * 3600,
	"PST": -8 * 3600, "PDT": -7 * 3600,
	"CET": 1 * 3600, "CEST": 2 * 3600,
}

// parseFeedDate parses value with layout and corrects abbreviation-zone dates
// that time.Parse mis-read as UTC (see tzOffsets).
func parseFeedDate(layout, value string) (time.Time, error) {
	t, err := time.Parse(layout, value)
	if err != nil {
		return t, err
	}
	if name, off := t.Zone(); off == 0 {
		if real, ok := tzOffsets[name]; ok && real != 0 {
			// Wall clock is right but the offset was lost: shift to the real
			// instant (UTC = wall - offset).
			t = t.Add(time.Duration(-real) * time.Second)
		}
	}
	return t, nil
}

func parseLink(r mod.RawFeedItem) string {
	var altFallback, hrefFallback string
	for _, f := range r["link"] {
		if href := f.Attr["href"]; href != "" {
			// Atom <link href rel>: an alternate/relless link is the article
			// URL. self/hub/enclosure/related are only a last resort.
			if rel := f.Attr["rel"]; rel == "" || rel == "alternate" {
				return href
			}
			if hrefFallback == "" {
				hrefFallback = href
			}
		} else if f.Txt != "" && altFallback == "" {
			// Plain RSS <link>url</link>: rank as the article URL, above a
			// non-alternate href, so a leading rel="self"/"hub" link can't
			// shadow it (which would also collapse guid-less items onto one
			// GUID and silently drop them).
			altFallback = f.Txt
		}
	}
	if altFallback != "" {
		return altFallback
	}
	return hrefFallback
}

// parseDate scans the priority-ordered dateFields, returning the first value
// that parses. hint caches only the layout (not the field): trying it first
// skips the format loop on the common case while still honouring field
// priority, so a first entry carrying only <updated> can't lock later entries
// onto <updated> in preference to their <published>.
func parseDate(r mod.RawFeedItem, hint *string) time.Time {
	for _, key := range dateFields {
		for _, f := range r[key] {
			if *hint != "" {
				if t, err := parseFeedDate(*hint, f.Txt); err == nil {
					return t.UTC()
				}
			}
			for _, layout := range dateFormats {
				if layout == *hint {
					continue
				}
				if t, err := parseFeedDate(layout, f.Txt); err == nil {
					*hint = layout
					return t.UTC()
				}
			}
		}
	}
	// Unix(0,0) sentinel for "no date". time.Time{}.Unix() is -62135596800,
	// which would leak negative timestamps into pack data and the watermark;
	// time.Now() would non-deterministically reorder undated items.
	return time.Unix(0, 0).UTC()
}

func rawToFeedItem(r mod.RawFeedItem, dateHint *string) *mod.RawItem {
	link := parseLink(r)
	published := parseDate(r, dateHint)

	title := r.Text("title")
	content := r.Text("content", "encoded", "description", "summary")

	guid := r.Text("guid", "id")
	if guid == "" {
		guid = link
	}
	if guid == "" {
		// No guid/id/link: derive a stable id from the item's own text so
		// distinct dateless/linkless items don't all collapse to hash("")
		// and dedup each other away.
		guid = "t:" + title + "\x00c:" + content
	}

	return &mod.RawItem{
		GUID:      hash(guid),
		Title:     title,
		Content:   content,
		Link:      link,
		Published: &published,
		Raw:       r,
	}
}

// errNotFeed classifies a document that is simply not a recognized feed — an
// HTML page, an unknown XML root, or non-XML bytes — as opposed to a genuine
// I/O or decoder fault while parsing something that *was* a feed. The caller
// branches on it (errors.Is) to attempt auto-discovery instead of failing hard.
var errNotFeed = errors.New("not a recognized feed")

// ParseFeed streams feed items to the callback and returns the feed's own
// channel/feed-level title (the first <title> directly under <channel> or the
// Atom <feed> root — never an <item>/<image> title; "" when absent). An error
// from the callback is propagated. A document that is not a recognized feed is
// reported wrapped in errNotFeed; a fault while parsing a recognized feed is a
// plain error. partial is true when the parse stopped at a malformed mid-feed
// element (still non-error — the items streamed so far are the good prefix):
// the caller must treat the response as incomplete (see Result.Partial).
func ParseFeed(data []byte, fn func(*mod.RawItem) error) (title string, partial bool, err error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	// Transcode declared non-UTF-8 encodings (ISO-8859-1, windows-1252, …) to
	// UTF-8: Go's encoding/xml is UTF-8 only and otherwise errors on the first
	// token, dropping the whole feed.
	dec.CharsetReader = charset.NewReaderLabel
	// Resolve the 250+ common named HTML entities (&nbsp;, &mdash;, …) that
	// aren't predefined XML entities, and tolerate unknown ones, instead of
	// aborting the entire feed on the first occurrence.
	dec.Strict = false
	dec.Entity = xml.HTMLEntity

	var itemTag string
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", false, fmt.Errorf("%w: detecting feed format: %w", errNotFeed, err)
		}
		if se, ok := tok.(xml.StartElement); ok {
			switch se.Name.Local {
			case "rss", "RDF":
				itemTag = "item"
			case "feed":
				itemTag = "entry"
			default:
				return "", false, fmt.Errorf("%w: unexpected root <%s>", errNotFeed, se.Name.Local)
			}
			break
		}
	}

	var dateHint string
	var feedTitle string
	var stack []string // open-element ancestry inside the root (item subtrees are consumed wholly, never pushed)
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return feedTitle, false, nil
		}
		if err != nil {
			return feedTitle, false, fmt.Errorf("parsing feed: %w", err)
		}
		switch se := tok.(type) {
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.StartElement:
			if se.Name.Local == itemTag {
				raw, err := parseElement(dec, se)
				if err != nil {
					// A malformed element wedges the decoder (Go's xml decoder rejects a
					// bare "]]>" even in non-strict mode, and keeps erroring after).
					// Stop here but keep the items parsed so far rather than dropping the
					// whole feed — reported as partial, so the caller withholds the
					// validators and the watermark advance and the next cycle refetches
					// the remainder instead of 304ing past it forever.
					slog.Warn("feed parse stopped at malformed element", "err", err)
					return feedTitle, true, nil
				}
				if err := fn(rawToFeedItem(raw.Chld, &dateHint)); err != nil {
					return feedTitle, false, err
				}
				continue
			}
			// The feed's own label: the first <title> directly under <channel>
			// (RSS/RDF) or under the Atom <feed> root itself. <item> titles never
			// reach here (consumed above) and <image>/<textinput> titles fail the
			// parent check ("image"/"textinput" tops the stack, not "channel").
			if feedTitle == "" && se.Name.Local == "title" &&
				((len(stack) > 0 && stack[len(stack)-1] == "channel") ||
					(itemTag == "entry" && len(stack) == 0)) {
				var s string
				if err := dec.DecodeElement(&s, &se); err == nil {
					feedTitle = strings.TrimSpace(s)
				}
				continue // DecodeElement consumed the whole element — nothing to push
			}
			stack = append(stack, se.Name.Local)
		}
	}
}

func parseElement(dec *xml.Decoder, start xml.StartElement) (mod.RawField, error) {
	var f mod.RawField
	if len(start.Attr) > 0 {
		f.Attr = make(map[string]string, len(start.Attr))
		for _, a := range start.Attr {
			f.Attr[a.Name.Local] = a.Value
		}
	}

	// Atom xhtml-typed content/summary carries its body as child elements
	// rather than CharData, so the default text capture below would yield "".
	// Capture the inner markup verbatim so the article body isn't lost; the
	// later #sanitize step clamps it to the allowed element set.
	if f.Attr["type"] == "xhtml" {
		inner, err := captureInnerXML(dec)
		if err != nil {
			return f, fmt.Errorf("parsing <%s>: %w", start.Name.Local, err)
		}
		f.Txt = inner
		return f, nil
	}

	var txt strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			return f, fmt.Errorf("parsing <%s>: %w", start.Name.Local, err)
		}
		switch t := tok.(type) {
		case xml.CharData:
			txt.Write(t)
		case xml.EndElement:
			f.Txt = strings.TrimSpace(txt.String())
			return f, nil
		case xml.StartElement:
			child, err := parseElement(dec, t)
			if err != nil {
				return f, err
			}
			if f.Chld == nil {
				f.Chld = make(mod.RawFeedItem)
			}
			f.Chld[t.Name.Local] = append(f.Chld[t.Name.Local], child)
			// Fold inner-element text back into the running text so mixed-content
			// fields like <description>Hello <b>world</b> foo</description> preserve
			// all text nodes, not just the direct CharData of this element.
			txt.WriteString(child.Txt)
		}
	}
}

// captureInnerXML serializes the markup inside start (already consumed by the
// caller) up to its matching end tag, stripping XML namespaces so the result
// is clean HTML for the sanitize step. Used for Atom type="xhtml" bodies.
func captureInnerXML(dec *xml.Decoder) (string, error) {
	var b strings.Builder
	enc := xml.NewEncoder(&b)
	depth := 1
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			if err := enc.EncodeToken(stripNS(t)); err != nil {
				return "", err
			}
		case xml.EndElement:
			depth--
			if depth == 0 {
				if err := enc.Flush(); err != nil {
					return "", err
				}
				return strings.TrimSpace(b.String()), nil
			}
			if err := enc.EncodeToken(xml.EndElement{Name: xml.Name{Local: t.Name.Local}}); err != nil {
				return "", err
			}
		default:
			if err := enc.EncodeToken(tok); err != nil {
				return "", err
			}
		}
	}
}

// stripNS drops namespace prefixes and xmlns declarations from a start tag so
// the re-serialized xhtml body is plain HTML (e.g. <div>, not <ns:div xmlns…>).
func stripNS(se xml.StartElement) xml.StartElement {
	out := xml.StartElement{Name: xml.Name{Local: se.Name.Local}}
	for _, a := range se.Attr {
		if a.Name.Local == "xmlns" || a.Name.Space == "xmlns" {
			continue
		}
		out.Attr = append(out.Attr, xml.Attr{Name: xml.Name{Local: a.Name.Local}, Value: a.Value})
	}
	return out
}
