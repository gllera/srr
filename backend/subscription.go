package main

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"strings"

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

type Subscription struct {
	ID            int      `json:"id"`
	Title         string   `json:"title"`
	URL           string   `json:"url"`
	Tag           string   `json:"tag,omitempty"`
	Pipeline      []string `json:"pipe,omitempty"`
	FetchError    string   `json:"ferr,omitempty"`
	StopGUID      uint32   `json:"stop_guid,omitempty"`
	ETag          string   `json:"etag,omitempty"`
	LastModified  string   `json:"last_modified,omitempty"`
	TotalArticles int      `json:"total_art,omitempty"`
	LastAddedAt   int64    `json:"last_added,omitempty"`
	newItems      []*Item
}

func (s Subscription) LogValue() slog.Value {
	return slog.GroupValue(
		slog.Int("id", s.ID),
		slog.String("url", s.URL),
	)
}

func (s *Subscription) Fetch(ctx context.Context, client *http.Client, buf []byte, processor *mod.Module) error {
	slog.Debug("downloading subscription", "sub", s)

	req, err := http.NewRequestWithContext(ctx, "GET", s.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "SRR/"+version)
	if s.ETag != "" {
		req.Header.Set("If-None-Match", s.ETag)
	}
	if s.LastModified != "" {
		req.Header.Set("If-Modified-Since", s.LastModified)
	}

	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotModified {
		slog.Debug("subscription not modified", "sub", s)
		return nil
	}

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP status: %s", res.Status)
	}

	etag := res.Header.Get("ETag")
	lastModified := res.Header.Get("Last-Modified")

	n, err := io.ReadFull(res.Body, buf)
	if err == nil {
		return fmt.Errorf("subscription file bigger than %d bytes", cap(buf)-1)
	}
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("empty response from subscription")
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}

	s.newItems = s.newItems[:0]
	var last *mod.RawItem

	err = parseFeed(buf[:n], func(i *mod.RawItem) error {
		if last == nil {
			last = i
		}
		if s.StopGUID == i.GUID {
			return ErrStopFeed
		}
		if err := processItem(ctx, processor, s.Pipeline, i); err != nil {
			return err
		}

		s.newItems = append(s.newItems, &Item{
			Sub:       s,
			Title:     i.Title,
			Content:   i.Content,
			Link:      i.Link,
			Published: i.Published.Unix(),
		})
		return nil
	})

	if err != nil {
		return err
	}
	if last != nil {
		s.StopGUID = last.GUID
	}
	s.ETag = etag
	s.LastModified = lastModified
	return nil
}
