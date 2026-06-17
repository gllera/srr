package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// InspectCmd mirrors the frontend's bounds-based pack lookup so a pass
// here means the read path the browser uses is consistent with the pack
// files on disk. The idx parse + addressing mirror itself lives in
// idx_read.go (shared with `srr art ls`).
type InspectCmd struct {
	URL      string `optional:"" help:"HTTP base URL (e.g., http://localhost:3000). Overrides --store."`
	Chron    int    `default:"-1" help:"Inspect a specific chronIdx; omit for other modes."`
	Validate bool   `help:"Walk every chronIdx and report any pack inconsistency (bounds, db meta, feedCounts/fetchedAts continuity, unknown feed_ids, latest-pack files)."`
	Filter   string `help:"Tag name or numeric feed_id; reports count and chron range matching the filter (mirrors frontend filter logic)."`
	Floor    int    `default:"0" help:"Optional floor chronIdx for --filter."`
	FromHash string `help:"Replay nav.fromHash on a frontend URL hash like '0,2485!big_info': resolves filter, decides resolve()/last(), prints final article."`
	ListTags bool   `help:"List tags and their feed/article counts (mirrors frontend groupFeedsByTag)."`
}

func (o *InspectCmd) Run() error {
	ctx := context.Background()
	fetch, cleanup, err := o.openFetcher(ctx)
	if err != nil {
		return err
	}
	if cleanup != nil {
		defer cleanup()
	}

	core, err := loadCore(fetch)
	if err != nil {
		return err
	}
	fmt.Printf("db: total_art=%d  next_pid=%d  seq=%d  pack_off=%d  first_fetched=%d\n",
		core.TotalArticles, core.NextPackID, core.Seq, core.PackOffset, core.FirstFetchedAt)

	if core.TotalArticles == 0 {
		fmt.Println("no articles")
		return nil
	}

	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		return err
	}
	for _, p := range packs {
		fmt.Printf("idx pack %d: %d entries, %d bounds (first=%+v last=%+v)\n",
			p.packIndex, p.packSize, len(p.bounds), p.bounds[0], p.bounds[len(p.bounds)-1])
	}

	if o.Validate {
		return validateAll(fetch, core, packs)
	}
	if o.ListTags {
		return listTagsReport(core)
	}
	if o.FromHash != "" {
		return fromHashReport(fetch, core, packs, o.FromHash)
	}
	if o.Filter != "" {
		return filterReport(core, packs, o.Filter, o.Floor)
	}
	if o.Chron < 0 {
		fmt.Println("(use --chron, --validate, --filter, --from-hash, or --list-tags)")
		return nil
	}
	return inspectOne(fetch, core, packs, o.Chron)
}

func (o *InspectCmd) openFetcher(ctx context.Context) (keyGetter, func(), error) {
	if o.URL != "" {
		return httpFetcher(o.URL), nil, nil
	}
	db, err := NewDB(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	return func(key string) ([]byte, error) {
		return db.readGz(ctx, key)
	}, func() { db.Close(ctx) }, nil
}

func httpFetcher(base string) keyGetter {
	return func(key string) ([]byte, error) {
		u, err := url.JoinPath(base, key)
		if err != nil {
			return nil, err
		}
		res, err := http.Get(u)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: %d", u, res.StatusCode)
		}
		data, err := gunzip(res.Body)
		if err != nil {
			return nil, fmt.Errorf("gunzip %s: %w", key, err)
		}
		return data, nil
	}
}

func loadCore(fetch keyGetter) (*DBCore, error) {
	data, err := fetch(dbFileKey)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", dbFileKey, err)
	}
	var c DBCore
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
	}
	return &c, nil
}

func loadDataPack(fetch keyGetter, key string) ([]ArticleData, error) {
	data, err := fetch(key)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", key, err)
	}
	entries, err := parseDataPack(data)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	return entries, nil
}

func truncStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
