package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"strings"
	"time"

	"srrb/mod"
)

var ErrStopFeed = errors.New("stop feed")

func hash(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

type rawField struct {
	Txt  string            `json:"@,omitempty"`
	Attr map[string]string `json:"$,omitempty"`
	Chld rawFeedItem       `json:"+,omitempty"`
}

type rawFeedItem map[string][]rawField

func (r rawFeedItem) text(names ...string) string {
	for _, name := range names {
		for _, f := range r[name] {
			if f.Txt != "" {
				return f.Txt
			}
		}
	}
	return ""
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

func parseLink(r rawFeedItem) string {
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

func parseDate(r rawFeedItem) time.Time {
	for _, key := range dateFields {
		for _, f := range r[key] {
			for _, layout := range dateFormats {
				if t, err := time.Parse(layout, f.Txt); err == nil {
					return t.UTC()
				}
			}
		}
	}
	return time.Now().UTC()
}

func rawToFeedItem(r rawFeedItem) *mod.RawItem {
	link := parseLink(r)
	published := parseDate(r)

	guid := r.text("guid", "id")
	if guid == "" {
		guid = link
	}

	return &mod.RawItem{
		GUID:      hash(guid),
		Title:     r.text("title"),
		Content:   r.text("content", "encoded", "description", "summary"),
		Link:      link,
		Published: &published,
		Raw:       &r,
	}
}

// parseFeed streams feed items to the callback. If the callback returns
// ErrStopFeed, parsing stops without error. Any other error is propagated.
func parseFeed(data []byte, fn func(*mod.RawItem) error) error {
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

	for {
		tok, err := dec.Token()
		if err == io.EOF {
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
		if err := fn(rawToFeedItem(raw.Chld)); errors.Is(err, ErrStopFeed) {
			return nil
		} else if err != nil {
			return err
		}
	}
}

func parseElement(dec *xml.Decoder, start xml.StartElement) (rawField, error) {
	var f rawField
	if len(start.Attr) > 0 {
		f.Attr = make(map[string]string, len(start.Attr))
		for _, a := range start.Attr {
			f.Attr[a.Name.Local] = a.Value
		}
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			return f, fmt.Errorf("parsing <%s>: %w", start.Name.Local, err)
		}
		switch t := tok.(type) {
		case xml.CharData:
			f.Txt += string(t)
		case xml.EndElement:
			f.Txt = strings.TrimSpace(f.Txt)
			return f, nil
		case xml.StartElement:
			child, err := parseElement(dec, t)
			if err != nil {
				return f, err
			}
			if f.Chld == nil {
				f.Chld = make(rawFeedItem)
			}
			f.Chld[t.Name.Local] = append(f.Chld[t.Name.Local], child)
		}
	}
}
