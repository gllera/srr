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

	"srrb/mod"
)

// "#rss" is the default zero-config fetcher: HTTP GET with If-None-Match
// / If-Modified-Since hints, streamed into the shared per-worker buffer,
// then handed to the streaming RSS/Atom/RDF parser (ParseFeed) defined
// below.
func init() {
	Register("rss", func() FetchFunc {
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
		}
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

func parseLink(r mod.RawFeedItem) string {
	var fallback string
	for _, f := range r["link"] {
		if href := f.Attr["href"]; href != "" {
			if rel := f.Attr["rel"]; rel == "" || rel == "alternate" {
				return href
			}
			if fallback == "" {
				fallback = href
			}
		} else if f.Txt != "" && fallback == "" {
			fallback = f.Txt
		}
	}
	return fallback
}

func parseDate(r mod.RawFeedItem, hint *[2]string) time.Time {
	if hint[0] != "" {
		for _, f := range r[hint[0]] {
			if t, err := time.Parse(hint[1], f.Txt); err == nil {
				return t.UTC()
			}
		}
	}
	for _, key := range dateFields {
		for _, f := range r[key] {
			for _, layout := range dateFormats {
				if t, err := time.Parse(layout, f.Txt); err == nil {
					hint[0], hint[1] = key, layout
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

func rawToFeedItem(r mod.RawFeedItem, dateHint *[2]string) *mod.RawItem {
	link := parseLink(r)
	published := parseDate(r, dateHint)

	guid := r.Text("guid", "id")
	if guid == "" {
		guid = link
	}

	return &mod.RawItem{
		GUID:      hash(guid),
		Title:     r.Text("title"),
		Content:   r.Text("content", "encoded", "description", "summary"),
		Link:      link,
		Published: &published,
		Raw:       r,
	}
}

// ParseFeed streams feed items to the callback. If the callback returns
// ErrStopFeed, parsing stops without error. Any other error is propagated.
func ParseFeed(data []byte, fn func(*mod.RawItem) error) error {
	dec := xml.NewDecoder(bytes.NewReader(data))

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

	var dateHint [2]string
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
