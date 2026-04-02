package main

import (
	"bufio"
	"bytes"
	"context"
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
	Published  int64
	Title      string
	Link       string
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
					Published: e.Published,
					SubID:     e.SubID,
					Title:     e.Title,
					Link:      e.Link,
				},
			}
			results = append(results, ar)
			lastID = artID
		}

		packNum--
		pos = idxPackSize - 1
	}

	if o.Full && len(results) > 0 {
		if err := loadContent(ctx, db, results); err != nil {
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
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 7 {
			continue
		}
		fetchedAt, _ := strconv.ParseInt(fields[0], 10, 64)
		packID, _ := strconv.Atoi(fields[1])
		packOffset, _ := strconv.Atoi(fields[2])
		subID, _ := strconv.Atoi(fields[3])
		published, _ := strconv.ParseInt(fields[4], 10, 64)

		entries = append(entries, idxEntry{
			FetchedAt:  fetchedAt,
			PackID:     packID,
			PackOffset: packOffset,
			SubID:      subID,
			Published:  published,
			Title:      fields[5],
			Link:       fields[6],
		})
	}
	return entries, nil
}

func loadContent(ctx context.Context, db *DB, results []articleResult) error {
	dataCache := map[int][][]byte{}
	for i := range results {
		ref := &results[i]
		parts, ok := dataCache[ref.packID]
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
			parts = bytes.Split(data, []byte{0})
			if len(parts) > 0 && len(parts[len(parts)-1]) == 0 {
				parts = parts[:len(parts)-1]
			}
			dataCache[ref.packID] = parts
		}
		if ref.packOffset < len(parts) {
			s := string(parts[ref.packOffset])
			ref.output.Content = &s
		}
	}
	return nil
}
