package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"srrb/mod"
)

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
