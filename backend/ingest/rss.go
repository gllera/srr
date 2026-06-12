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

	"srrb/mod"
)

// "#rss" is the default zero-config fetcher: HTTP GET with If-None-Match
// / If-Modified-Since hints, streamed into the shared per-worker buffer,
// then handed to the streaming RSS/Atom/RDF parser (ParseFeed) defined
// below.
func init() {
	Register("rss", func(Deps) (FetchFunc, io.Closer) {
		return func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error) {
			httpReq, err := http.NewRequestWithContext(ctx, "GET", req.URL, nil)
			if err != nil {
				return Result{}, err
			}
			httpReq.Header.Set("User-Agent", userAgent)
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
			err = ParseFeed(data, func(i *mod.RawItem) error {
				items = append(items, i)
				return nil
			})
			if err != nil {
				return Result{}, err
			}

			return Result{
				ETag:         res.Header.Get("ETag"),
				LastModified: res.Header.Get("Last-Modified"),
				Items:        items,
			}, nil
		}, nil
	})
}

// --- RSS/Atom/RDF feed parser -----------------------------------------

// ErrStopFeed is the sentinel a ParseFeed callback returns to stop early
// without error. Currently unused in production code; kept for the API.
var ErrStopFeed = errors.New("stop feed")

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

// ParseFeed streams feed items to the callback. If the callback returns
// ErrStopFeed, parsing stops without error. Any other error is propagated.
func ParseFeed(data []byte, fn func(*mod.RawItem) error) error {
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
			return fmt.Errorf("detecting feed format: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok {
			switch se.Name.Local {
			case "rss", "RDF":
				itemTag = "item"
			case "feed":
				itemTag = "entry"
			default:
				return fmt.Errorf("unsupported feed format: <%s>", se.Name.Local)
			}
			break
		}
	}

	var dateHint string
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("parsing feed: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != itemTag {
			continue
		}
		raw, err := parseElement(dec, se)
		if err != nil {
			return err
		}
		if err := fn(rawToFeedItem(raw.Chld, &dateHint)); errors.Is(err, ErrStopFeed) {
			return nil
		} else if err != nil {
			return err
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
