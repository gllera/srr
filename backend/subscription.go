package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"

	"srrb/mod"
)

var titlePolicy = bluemonday.StrictPolicy()

func processItem(ctx context.Context, processor *mod.Module, pipeline []string, i *mod.RawItem) error {
	for _, m := range pipeline {
		if err := processor.Process(ctx, m, i); err != nil {
			return fmt.Errorf("module %q failed: %w", m, err)
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

type Source struct {
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	StopGUID     uint32 `json:"stop_guid,omitempty"`
	FetchError   string `json:"ferr,omitempty"`
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

// UnmarshalJSON folds the pre-Sources DB layout (url/etag/last_modified/
// stop_guid/ferr at the subscription level) into a single Source. Without
// this, upgrading an existing pack silently drops StopGUID/ETag and re-fetches
// the entire feed history on the next run.
func (s *Subscription) UnmarshalJSON(data []byte) error {
	type alias Subscription
	aux := &struct {
		URL          string `json:"url,omitempty"`
		ETag         string `json:"etag,omitempty"`
		LastModified string `json:"last_modified,omitempty"`
		StopGUID     uint32 `json:"stop_guid,omitempty"`
		FetchError   string `json:"ferr,omitempty"`
		*alias
	}{alias: (*alias)(s)}
	if err := json.Unmarshal(data, aux); err != nil {
		return err
	}
	if len(s.Sources) == 0 && aux.URL != "" {
		s.Sources = []*Source{{
			URL:          aux.URL,
			ETag:         aux.ETag,
			LastModified: aux.LastModified,
			StopGUID:     aux.StopGUID,
			FetchError:   aux.FetchError,
		}}
	}
	return nil
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

func (s *Subscription) Fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module) {
	s.newItems = s.newItems[:0]
	for _, src := range s.Sources {
		items, err := src.fetch(ctx, client, buf, processor, s)
		if err != nil {
			src.FetchError = err.Error()
			slog.Error("source fetch failed", "sub", s, "url", src.URL, "err", err)
			continue
		}
		src.FetchError = ""
		s.newItems = append(s.newItems, items...)
	}
}

func (src *Source) fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module, sub *Subscription) ([]*Item, error) {
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

	// Track the GUID of the item with the latest Published time so the next
	// fetch halts at it whether the feed is descending (RSS, most Atom) or
	// ascending (some Atom generators). Capture by value: the pipeline can
	// mutate i.Published in-place, and a pointer to a previous item could
	// nil-deref on the next iteration's comparison.
	var newestPub time.Time
	var newestGUID uint32
	var hasNewest bool
	var items []*Item

	err = parseFeed(buf[:n], func(i *mod.RawItem) error {
		if i.Published != nil && (!hasNewest || i.Published.After(newestPub)) {
			newestPub = *i.Published
			newestGUID = i.GUID
			hasNewest = true
		}
		if src.StopGUID == i.GUID {
			return ErrStopFeed
		}
		if err := processItem(ctx, processor, sub.Pipeline, i); err != nil {
			return err
		}

		var publishedUnix int64
		if i.Published != nil && !i.Published.IsZero() {
			publishedUnix = i.Published.Unix()
		}
		items = append(items, &Item{
			Sub:       sub,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: publishedUnix,
		})
		return nil
	})

	if err != nil {
		return nil, err
	}
	if hasNewest {
		src.StopGUID = newestGUID
	}
	src.ETag = etag
	src.LastModified = lastModified
	return items, nil
}
