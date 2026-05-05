package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

type ArtCmd struct {
	ID     []int    `short:"i" optional:"" help:"Filter by subscription ID(s)."`
	Tag    []string `short:"g" optional:"" help:"Filter by tag(s)."`
	Limit  int      `short:"l" default:"50" help:"Max articles to return."`
	Before *int     `short:"b" optional:"" help:"Return articles before this artID (exclusive). Omit for newest."`
}

type idxEntry struct {
	ChronIdx   int
	FetchedAt  int64
	PackID     int
	PackOffset int
	SubID      int
}

type articleResult struct {
	ArticleData
	Idx        int `json:"x"`
	packID     int
	packOffset int
}

type articlesOutput struct {
	Articles   []articleResult `json:"articles"`
	Total      int             `json:"total"`
	NextCursor *int            `json:"next_cursor,omitempty"`
}

func (o *ArtCmd) Run() error {
	ctx := context.Background()
	db, err := NewDB(ctx, false)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	total := db.core.TotalArticles
	if total == 0 {
		return printJSON(&articlesOutput{Articles: []articleResult{}, Total: 0})
	}

	// Build filter set (nil = accept all)
	var filter map[int]bool
	if len(o.ID) > 0 || len(o.Tag) > 0 {
		filter = map[int]bool{}
		for _, id := range o.ID {
			filter[id] = true
		}
		for _, tag := range o.Tag {
			for _, s := range db.Subscriptions() {
				if s.Tag == tag {
					filter[s.id] = true
				}
			}
		}
	}

	entries, err := readAllIdx(ctx, db)
	if err != nil {
		return err
	}

	filteredTotal := 0
	for _, e := range entries {
		if filter == nil || filter[e.SubID] {
			filteredTotal++
		}
	}

	startIdx := len(entries) - 1
	if o.Before != nil {
		startIdx = sort.Search(len(entries), func(i int) bool {
			return entries[i].ChronIdx >= *o.Before
		}) - 1
	}
	if startIdx < 0 {
		return printJSON(&articlesOutput{Articles: []articleResult{}, Total: filteredTotal})
	}

	var results []articleResult
	lastID := -1

	for i := startIdx; i >= 0 && len(results) < o.Limit; i-- {
		e := &entries[i]
		if filter != nil && !filter[e.SubID] {
			continue
		}
		results = append(results, articleResult{
			Idx:        e.ChronIdx,
			packID:     e.PackID,
			packOffset: e.PackOffset,
		})
		lastID = e.ChronIdx
	}

	if len(results) > 0 {
		if err := loadContent(ctx, db, results); err != nil {
			return err
		}
	}

	out := &articlesOutput{
		Articles: results,
		Total:    filteredTotal,
	}
	if lastID > 0 && len(results) == o.Limit {
		out.NextCursor = &lastID
	}

	return printJSON(out)
}

func readAllIdx(ctx context.Context, db *DB) ([]idxEntry, error) {
	total := db.core.TotalArticles
	numFinalized := 0
	if total > 0 {
		numFinalized = (total - 1) / idxPackSize
	}

	packID := 0
	packOffset := 0
	fetchedAt := db.core.FirstFetchedAt / 28800 * 28800
	chronIdx := 0

	entries := make([]idxEntry, 0, total)
	for p := 0; p <= numFinalized; p++ {
		var key string
		if p < numFinalized {
			key = fmt.Sprintf("idx/%d.gz", p)
		} else {
			key = fmt.Sprintf("idx/%v.gz", db.core.DataToggle)
		}

		data, err := db.readGz(ctx, key)
		if err != nil {
			return nil, err
		}

		for off := idxHeaderSize; off+2 <= len(data); off += 2 {
			packed := data[off+1]
			fetchedAt += int64(packed&0x7F) * 28800
			if packed>>7 != 0 {
				packID++
				packOffset = 0
			} else {
				packOffset++
			}
			subID := int(data[off])
			if sub := db.Subscriptions()[subID]; sub != nil && chronIdx >= sub.AddIdx {
				entries = append(entries, idxEntry{
					ChronIdx:   chronIdx,
					SubID:      subID,
					PackID:     packID,
					PackOffset: packOffset,
					FetchedAt:  fetchedAt,
				})
			}
			chronIdx++
		}
	}

	return entries, nil
}

func loadContent(ctx context.Context, db *DB, results []articleResult) error {
	dataCache := map[int][]ArticleData{}
	for i := range results {
		ref := &results[i]
		articles, ok := dataCache[ref.packID]
		if !ok {
			var key string
			if ref.packID < db.core.NextPackID {
				key = fmt.Sprintf("data/%d.gz", ref.packID)
			} else {
				key = fmt.Sprintf("data/%v.gz", db.core.DataToggle)
			}
			data, err := db.readGz(ctx, key)
			if err != nil {
				return err
			}
			dec := json.NewDecoder(bytes.NewReader(data))
			for dec.More() {
				var ad ArticleData
				if err := dec.Decode(&ad); err != nil {
					return err
				}
				articles = append(articles, ad)
			}
			dataCache[ref.packID] = articles
		}
		if ref.packOffset < len(articles) {
			ref.ArticleData = articles[ref.packOffset]
		}
	}
	return nil
}
