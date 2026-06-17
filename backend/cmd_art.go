package main

import (
	"context"
	"sort"
)

type ArtCmd struct {
	ID     []int    `short:"i" optional:"" help:"Filter by feed ID(s)."`
	Tag    []string `short:"g" optional:"" help:"Filter by tag(s)."`
	Limit  int      `short:"l" default:"50" help:"Max articles to return."`
	Before *int     `short:"b" optional:"" help:"Return articles before this artID (exclusive). Omit for newest."`
}

type idxEntry struct {
	ChronIdx   int
	PackID     int
	PackOffset int
	FeedID     int
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
	return withDB(false, func(ctx context.Context, db *DB) error {
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
				for _, ch := range db.Feeds() {
					if ch.Tag == tag {
						filter[ch.id] = true
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
			if filter == nil || filter[e.FeedID] {
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
			if filter != nil && !filter[e.FeedID] {
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
	})
}

func readAllIdx(ctx context.Context, db *DB) ([]idxEntry, error) {
	packs, err := loadIdxPacks(func(key string) ([]byte, error) {
		return db.readGz(ctx, key)
	}, &db.core)
	if err != nil {
		return nil, err
	}

	entries := make([]idxEntry, 0, db.core.TotalArticles)
	for _, p := range packs {
		base := p.packIndex * idxPackSize
		for i, sub := range p.feedIDs {
			chron := base + i
			feedID := int(sub)
			ch := db.Feeds()[feedID]
			if ch == nil || chron < ch.AddIdx {
				continue
			}
			packID, packOffset := p.getPackRef(chron)
			entries = append(entries, idxEntry{
				ChronIdx:   chron,
				FeedID:     feedID,
				PackID:     packID,
				PackOffset: packOffset,
			})
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
			data, err := db.readGz(ctx, dataKeyFor(&db.core, ref.packID))
			if err != nil {
				return err
			}
			articles, err = parseDataPack(data)
			if err != nil {
				return err
			}
			dataCache[ref.packID] = articles
		}
		if ref.packOffset < len(articles) {
			ref.ArticleData = articles[ref.packOffset]
		}
	}
	return nil
}
