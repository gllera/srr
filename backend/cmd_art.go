package main

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// dayWeekRe matches the `d`/`w` duration units time.ParseDuration lacks. No Go
// duration unit contains either letter (ns/µs/ms/s/m/h), so rewriting them to
// hours is unambiguous and composes with the built-in units ("1d12h").
var dayWeekRe = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)([dw])`)

// parseTimeBound resolves a --since/--until value to a unix second. Accepted
// forms, tried in order: a relative duration before `now` (Go units plus d/w),
// a bare local date, or an RFC3339 instant. Bare unix seconds are deliberately
// not a form.
func parseTimeBound(s string, now time.Time) (int64, error) {
	if s == "" {
		return 0, fmt.Errorf("empty time value")
	}

	expanded := dayWeekRe.ReplaceAllStringFunc(s, func(m string) string {
		g := dayWeekRe.FindStringSubmatch(m)
		n, err := strconv.ParseFloat(g[1], 64)
		if err != nil {
			return m // leave it for ParseDuration to reject
		}
		if g[2] == "w" {
			n *= 7
		}
		return strconv.FormatFloat(n*24, 'f', -1, 64) + "h"
	})
	if d, err := time.ParseDuration(expanded); err == nil {
		if d < 0 {
			return 0, fmt.Errorf("negative duration %q: a window bound cannot be in the future", s)
		}
		return now.Add(-d).Unix(), nil
	}

	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return t.Unix(), nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix(), nil
	}

	return 0, fmt.Errorf("invalid time %q: want a duration before now (24h, 7d, 2w), a date (2006-01-02), or an RFC3339 instant (2006-01-02T15:04:05Z)", s)
}

type ArtCmd struct {
	ID     []int    `short:"i" optional:"" help:"Filter by feed ID(s)."`
	Tag    []string `short:"g" optional:"" help:"Filter by tag(s)."`
	Limit  int      `short:"l" default:"50" help:"Max articles to return."`
	Before *int     `short:"b" optional:"" help:"Return articles before this artID (exclusive). Omit for newest."`
	// No short flags: kong flattens the globals into every command, and -s/-u
	// are already spoken for there.
	Since string `optional:"" help:"Only articles fetched at or after this time: a duration before now (24h, 7d, 2w), a date (2026-07-15), or an RFC3339 instant."`
	Until string `optional:"" help:"Only articles fetched at or before this time (same forms as --since)."`
}

// window resolves --since/--until into inclusive unix-second bounds; a nil
// bound is open-ended. The clock is fetched_at (ingest time), not published:
// it is chron-monotone, so a window is a contiguous chron range.
func (o *ArtCmd) window(now time.Time) (since, until *int64, err error) {
	if o.Since != "" {
		t, err := parseTimeBound(o.Since, now)
		if err != nil {
			return nil, nil, fmt.Errorf("--since: %w", err)
		}
		since = &t
	}
	if o.Until != "" {
		t, err := parseTimeBound(o.Until, now)
		if err != nil {
			return nil, nil, fmt.Errorf("--until: %w", err)
		}
		until = &t
	}
	if since != nil && until != nil && *since > *until {
		return nil, nil, fmt.Errorf("--since %q is after --until %q: the window is empty", o.Since, o.Until)
	}
	return since, until, nil
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
	// Both bounds resolve against one `now`, so a relative window can't
	// straddle a clock tick mid-command.
	since, until, err := o.window(time.Now())
	if err != nil {
		return err
	}
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

		entries, deltas, err := readAllIdx(ctx, db)
		if err != nil {
			return err
		}

		reader := newPackReader(ctx, db, deltas)
		lo, hi, err := reader.findWindow(entries, since, until)
		if err != nil {
			return err
		}

		// Total counts the window, not the store: it answers "how many
		// articles does this query match", which is what the returned page is
		// drawn from.
		filteredTotal := 0
		for i := lo; i <= hi; i++ {
			if filter == nil || filter[entries[i].FeedID] {
				filteredTotal++
			}
		}

		startIdx := hi
		if o.Before != nil {
			b := sort.Search(len(entries), func(i int) bool {
				return entries[i].ChronIdx >= *o.Before
			}) - 1
			if b < startIdx {
				startIdx = b
			}
		}
		if startIdx < lo {
			return printJSON(&articlesOutput{Articles: []articleResult{}, Total: filteredTotal})
		}

		var results []articleResult
		lastID := -1

		for i := startIdx; i >= lo && len(results) < o.Limit; i-- {
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
			if err := reader.loadContent(results); err != nil {
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

func readAllIdx(ctx context.Context, db *DB) ([]idxEntry, []ArticleData, error) {
	packs, deltas, err := loadIdxPacks(func(key string) ([]byte, error) {
		return db.readGz(ctx, key)
	}, &db.core)
	if err != nil {
		return nil, nil, err
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

	return entries, deltas, nil
}

// packReader resolves idx entries to the ArticleData they address, caching
// every data pack it touches. The window search and the content fill share one
// instance, so a pack read while locating the window is never read twice.
type packReader struct {
	ctx    context.Context
	db     *DB
	deltas []ArticleData
	cache  map[int][]ArticleData
}

func newPackReader(ctx context.Context, db *DB, deltas []ArticleData) *packReader {
	return &packReader{ctx: ctx, db: db, deltas: deltas, cache: map[int][]ArticleData{}}
}

// at resolves one entry's record. ok is false when the entry addresses past
// the end of its pack — a corrupt store; callers decide whether that is fatal.
func (r *packReader) at(packID, packOffset int) (ArticleData, bool, error) {
	// Delta-region articles (packID == deltaPackID) resolve from the
	// already-parsed chain — there is no data pack to read for them.
	if packID == deltaPackID {
		if packOffset >= len(r.deltas) {
			return ArticleData{}, false, nil
		}
		return r.deltas[packOffset], true, nil
	}
	articles, cached := r.cache[packID]
	if !cached {
		data, err := r.db.readGz(r.ctx, dataKeyFor(&r.db.core, packID))
		if err != nil {
			return ArticleData{}, false, err
		}
		articles, err = parseDataPack(data)
		if err != nil {
			return ArticleData{}, false, err
		}
		r.cache[packID] = articles
	}
	if packOffset >= len(articles) {
		return ArticleData{}, false, nil
	}
	return articles[packOffset], true, nil
}

// findWindow maps the inclusive fetched_at bounds to the inclusive entry-index
// range [lo, hi]; a nil bound is open-ended. fetched_at is chron-monotone (one
// stamp per fetch cycle, applied to the whole batch — the same property
// ExpireArticles relies on), so the window is contiguous and two binary
// searches locate it, reading O(log n) data packs instead of the whole series.
// hi < lo means no article falls in the window.
func (r *packReader) findWindow(entries []idxEntry, since, until *int64) (int, int, error) {
	lo, hi := 0, len(entries)-1
	var probeErr error
	fetchedAt := func(i int) int64 {
		if probeErr != nil {
			return 0
		}
		ad, ok, err := r.at(entries[i].PackID, entries[i].PackOffset)
		switch {
		case err != nil:
			probeErr = err
		case !ok:
			// Unlike the content fill, which tolerates a missing record by
			// leaving the row blank, a search cannot: one bogus timestamp
			// silently relocates the whole window.
			probeErr = fmt.Errorf("chron %d addresses no data-pack record: cannot resolve the time window on this store", entries[i].ChronIdx)
		}
		return ad.FetchedAt
	}
	if since != nil {
		lo = sort.Search(len(entries), func(i int) bool { return fetchedAt(i) >= *since })
	}
	if until != nil {
		hi = sort.Search(len(entries), func(i int) bool { return fetchedAt(i) > *until }) - 1
	}
	if probeErr != nil {
		return 0, 0, probeErr
	}
	return lo, hi, nil
}

// loadContent fills in each result's ArticleData from its data pack.
func (r *packReader) loadContent(results []articleResult) error {
	for i := range results {
		ref := &results[i]
		ad, ok, err := r.at(ref.packID, ref.packOffset)
		if err != nil {
			return err
		}
		if ok {
			ref.ArticleData = ad
		}
	}
	return nil
}
