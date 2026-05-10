package main

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"

	"srrb/mod"
)

var titlePolicy = bluemonday.StrictPolicy()

func processItem(ctx context.Context, processor *mod.Module, pipeline []string, i *mod.RawItem) error {
	if len(pipeline) > 0 {
		GUID := i.GUID
		hadPub := i.Published != nil
		var pub time.Time
		if hadPub {
			pub = *i.Published
		}
		for _, m := range pipeline {
			if err := processor.Process(ctx, m, i); err != nil {
				return fmt.Errorf("module %q failed: %w", m, err)
			}
			if GUID != i.GUID {
				return fmt.Errorf("module %q changed GUID", m)
			}
			hasPub := i.Published != nil
			if hasPub != hadPub || (hasPub && !pub.Equal(*i.Published)) {
				return fmt.Errorf("module %q changed Published", m)
			}
		}
	}
	i.Title = html.UnescapeString(titlePolicy.Sanitize(i.Title))
	i.Title = strings.Join(strings.Fields(i.Title), " ")
	i.Link = strings.Map(stripControl, i.Link)
	i.Content = strings.Map(stripControlKeepWS, i.Content)
	return nil
}

func stripControl(r rune) rune {
	if r <= ' ' || r == 0x7f {
		return -1
	}
	return r
}

func stripControlKeepWS(r rune) rune {
	if r < ' ' && r != '\t' && r != '\n' && r != '\r' {
		return -1
	}
	return r
}

func validFeedURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme != "" && u.Host != ""
}

func uint32Set(s []uint32) map[uint32]struct{} {
	m := make(map[uint32]struct{}, len(s))
	for _, v := range s {
		m[v] = struct{}{}
	}
	return m
}

type Source struct {
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	// Watermark is the max published unix-second ever seen across fetches.
	Watermark int64 `json:"wm,omitempty"`
	// BoundaryGUIDs is the GUIDs from the most recent non-empty fetch whose
	// pub equals Watermark (the dated boundary) or equals 0 (dateless).
	// Repopulated each non-empty fetch from the current response so its size
	// stays bounded by what the publisher currently exposes; a 200 OK with
	// zero items leaves the field untouched so a transient empty channel
	// doesn't drop dedup state.
	BoundaryGUIDs []uint32 `json:"bg,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
}

type Subscription struct {
	id       int
	Title    string    `json:"title"`
	Sources  []*Source `json:"src"`
	Tag      string    `json:"tag,omitempty"`
	Pipeline []string  `json:"pipe,omitempty"`
	TotalArt int       `json:"total_art"`
	AddIdx   int       `json:"add_idx"`
	newItems []*Item
}

func (s *Subscription) URLs() string {
	urls := make([]string, len(s.Sources))
	for i, src := range s.Sources {
		urls[i] = src.URL
	}
	return strings.Join(urls, ", ")
}

func (s *Subscription) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", s.id),
		slog.String("urls", s.URLs()),
	)
}

func (s *Subscription) Fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, fetchedAt int64) {
	s.newItems = s.newItems[:0]
	for _, src := range s.Sources {
		items, err := src.fetch(ctx, client, buf, processor, s, fetchedAt)
		if err != nil {
			src.FetchError = err.Error()
			slog.Error("source fetch failed", "sub", s, "url", src.URL, "err", err)
			continue
		}
		src.FetchError = ""
		s.newItems = append(s.newItems, items...)
	}
}

func (src *Source) fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, sub *Subscription, fetchedAt int64) ([]*Item, error) {
	slog.Debug("downloading source", "url", src.URL, "sub", sub)

	req, err := http.NewRequestWithContext(ctx, "GET", src.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "SRR/"+version)
	if src.ETag != "" {
		req.Header.Set("If-None-Match", src.ETag)
	}
	if src.LastModified != "" {
		req.Header.Set("If-Modified-Since", src.LastModified)
	}

	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotModified {
		slog.Debug("source not modified", "url", src.URL)
		return nil, nil
	}

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP status: %s", res.Status)
	}

	etag := res.Header.Get("ETag")
	lastModified := res.Header.Get("Last-Modified")

	n, err := io.ReadFull(res.Body, buf)
	if err == nil {
		return nil, fmt.Errorf("subscription file bigger than %d bytes", cap(buf)-1)
	}
	if errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("empty response from subscription")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}

	// Back-dated items below Watermark are not recovered (single-cursor
	// limitation), and watermark-second or dateless items that disappear
	// from the feed and reappear are re-ingested as duplicates (snapshot
	// semantics over carry-over).
	priorWatermark := src.Watermark
	priorBoundary := uint32Set(src.BoundaryGUIDs)

	maxPub := priorWatermark
	boundary := make(map[uint32]int64)

	var items []*Item

	err = parseFeed(buf[:n], func(i *mod.RawItem) error {
		// Skip subsequent occurrences of the same GUID first so a within-fetch
		// duplicate cannot pollute boundary or maxPub with a stale pub.
		if _, dup := boundary[i.GUID]; dup {
			return nil
		}

		var pubUnix int64
		if i.Published != nil {
			if u := i.Published.Unix(); u > 0 {
				// Clamp future-dated items so a publisher CMS bug
				// (year-2099 default) can't push Watermark past now and
				// silently swallow every subsequent real item.
				pubUnix = min(u, fetchedAt)
			}
		}

		boundary[i.GUID] = pubUnix
		if pubUnix > maxPub {
			maxPub = pubUnix
		}

		if _, prev := priorBoundary[i.GUID]; prev {
			return nil
		}
		if pubUnix != 0 && pubUnix < priorWatermark {
			return nil
		}

		if err := processItem(ctx, processor, sub.Pipeline, i); err != nil {
			return err
		}
		items = append(items, &Item{
			Sub:       sub,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: pubUnix,
		})
		return nil
	})

	if err != nil {
		return nil, err
	}
	// A 200 OK with zero items (e.g. transient empty channel) leaves Watermark
	// and BoundaryGUIDs untouched so prior items still dedup if the feed
	// recovers next fetch. ETag/Last-Modified still advance — the response
	// was served and the publisher gets to update its caching headers.
	if len(boundary) > 0 {
		src.Watermark = maxPub
		bg := make([]uint32, 0, len(boundary))
		for g, p := range boundary {
			if p == 0 || p == maxPub {
				bg = append(bg, g)
			}
		}
		slices.Sort(bg)
		src.BoundaryGUIDs = bg
	}
	src.ETag = etag
	src.LastModified = lastModified
	return items, nil
}
