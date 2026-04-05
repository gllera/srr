package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type ArtCmd struct {
	ID     []int    `short:"i" optional:"" help:"Filter by subscription ID(s)."`
	Tag    []string `short:"g" optional:"" help:"Filter by tag(s)."`
	Limit  int      `short:"l" default:"50" help:"Max articles to return."`
	Before *int     `short:"b" optional:"" help:"Return articles before this artID (exclusive). Omit for newest."`
	Full   bool     `short:"f"             help:"Include article content."`
}

type idxEntry struct {
	FetchedAt  int64
	PackID     int
	PackOffset int
	SubID      int
}

type articleResult struct {
	output     articleOutput
	packID     int
	packOffset int
}

type articleOutput struct {
	ID        int     `json:"id"`
	FetchedAt int64   `json:"fetched_at"`
	Published int64   `json:"published"`
	SubID     int     `json:"sub_id"`
	Title     string  `json:"title"`
	Link      string  `json:"link,omitempty"`
	Content   *string `json:"content,omitempty"`
}

type articlesOutput struct {
	Articles   []articleOutput `json:"articles"`
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
		return printJSON(&articlesOutput{Articles: []articleOutput{}, Total: 0})
	}

	subMap := map[int]*Subscription{}
	for _, s := range db.Subscriptions() {
		subMap[s.ID] = s
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
					filter[s.ID] = true
				}
			}
		}
	}

	filteredTotal := total
	if filter != nil {
		filteredTotal = 0
		for id := range filter {
			if sub := subMap[id]; sub != nil {
				filteredTotal += sub.TotalArticles
			}
		}
	}

	startID := total - 1
	if o.Before != nil {
		startID = *o.Before - 1
	}
	if startID < 0 {
		return printJSON(&articlesOutput{Articles: []articleOutput{}, Total: filteredTotal})
	}
	if startID >= total {
		startID = total - 1
	}

	numFinalized := (total - 1) / idxPackSize

	packNum := startID / idxPackSize
	pos := startID % idxPackSize

	var results []articleResult
	lastID := -1

	for packNum >= 0 && len(results) < o.Limit {
		entries, err := readIdxPack(ctx, db, packNum, numFinalized)
		if err != nil {
			return err
		}

		if pos >= len(entries) {
			pos = len(entries) - 1
		}

		baseID := packNum * idxPackSize

		for i := pos; i >= 0 && len(results) < o.Limit; i-- {
			e := &entries[i]
			if filter != nil && !filter[e.SubID] {
				continue
			}

			artID := baseID + i
			ar := articleResult{
				packID:     e.PackID,
				packOffset: e.PackOffset,
				output: articleOutput{
					ID:        artID,
					FetchedAt: e.FetchedAt,
					SubID:     e.SubID,
				},
			}
			results = append(results, ar)
			lastID = artID
		}

		packNum--
		pos = idxPackSize - 1
	}

	if len(results) > 0 {
		if err := loadContent(ctx, db, results, o.Full); err != nil {
			return err
		}
	}

	out := &articlesOutput{
		Articles: make([]articleOutput, len(results)),
		Total:    filteredTotal,
	}
	for i := range results {
		out.Articles[i] = results[i].output
	}
	if lastID > 0 && len(results) == o.Limit {
		out.NextCursor = &lastID
	}

	return printJSON(out)
}

func readIdxPack(ctx context.Context, db *DB, packNum, numFinalized int) ([]idxEntry, error) {
	var key string
	if packNum < numFinalized {
		key = fmt.Sprintf("idx/%d.gz", packNum)
	} else {
		key = fmt.Sprintf("idx/%v.gz", db.core.DataToggle)
	}

	data, err := db.readGz(ctx, key)
	if err != nil {
		return nil, err
	}

	var entries []idxEntry
	var packID, packOffset int
	var fetchedAt int64
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for i := 0; scanner.Scan(); i++ {
		fields := strings.Split(scanner.Text(), "\t")
		if i == 0 {
			if len(fields) != 4 {
				continue
			}
			subID, _ := strconv.Atoi(fields[0])
			packID, _ = strconv.Atoi(fields[1])
			packOffset, _ = strconv.Atoi(fields[2])
			fetchedAt, _ = strconv.ParseInt(fields[3], 10, 64)
			entries = append(entries, idxEntry{FetchedAt: fetchedAt, PackID: packID, PackOffset: packOffset, SubID: subID})
		} else {
			if len(fields) != 3 {
				continue
			}
			subID, _ := strconv.Atoi(fields[0])
			delta, _ := strconv.Atoi(fields[1])
			deltaFetched, _ := strconv.ParseInt(fields[2], 10, 64)
			fetchedAt += deltaFetched
			if delta > 0 {
				packID += delta
				packOffset = 0
			} else {
				packOffset++
			}
			entries = append(entries, idxEntry{FetchedAt: fetchedAt, PackID: packID, PackOffset: packOffset, SubID: subID})
		}
	}
	return entries, nil
}

func loadContent(ctx context.Context, db *DB, results []articleResult, full bool) error {
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
			scanner := bufio.NewScanner(bytes.NewReader(data))
			for scanner.Scan() {
				line := scanner.Bytes()
				if len(line) == 0 {
					continue
				}
				var ad ArticleData
				if err := json.Unmarshal(line, &ad); err != nil {
					continue
				}
				articles = append(articles, ad)
			}
			dataCache[ref.packID] = articles
		}
		if ref.packOffset < len(articles) {
			ad := &articles[ref.packOffset]
			ref.output.Published = ad.Published
			ref.output.Title = ad.Title
			ref.output.Link = ad.Link
			if full {
				s := ad.Content
				ref.output.Content = &s
			}
		}
	}
	return nil
}
