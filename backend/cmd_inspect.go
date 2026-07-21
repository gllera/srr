package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
)

// InspectCmd mirrors the frontend's bounds-based pack lookup so a pass
// here means the read path the browser uses is consistent with the pack
// files on disk. The idx parse + addressing mirror itself lives in
// idx_read.go (shared with `srr art ls`).
type InspectCmd struct {
	URL      string `optional:"" help:"HTTP base URL (e.g., http://localhost:3000). Overrides --store."`
	Chron    int    `default:"-1" help:"Inspect a specific chronIdx; omit for other modes."`
	Validate bool   `help:"Walk every chronIdx and report any pack inconsistency (bounds, db meta, feedCounts continuity, unknown feed_ids, latest-pack files, idx summary, meta)."`
	Filter   string `help:"Tag name or numeric feed_id; reports count and chron range matching the filter (mirrors frontend filter logic)."`
	Floor    int    `default:"0" help:"Optional floor chronIdx for --filter."`
	FromHash string `help:"Replay nav.fromHash on a frontend URL hash like '0,2485!big_info': resolves filter, decides resolve()/last(), prints final article."`
	ListTags bool   `help:"List tags and their feed/article counts (mirrors frontend groupFeedsByTag)."`
	JSON     bool   `name:"json" help:"With --validate: emit {ok, issues:[{check, issues, detail}]} instead of the human report, for scripted health checks."`

	// out is where the report is written. The CLI leaves it nil (⇒ os.Stdout);
	// serve's /api/inspect passes a buffer. It exists so the handler never has
	// to swap the PROCESS-global os.Stdout — which was only safe while every
	// log happened to go to stderr, and forced a mutex to keep concurrent
	// requests from interleaving into each other's pipe.
	out io.Writer
}

// w resolves the report sink, defaulting to os.Stdout for the CLI.
func (o *InspectCmd) w() io.Writer {
	if o.out == nil {
		return os.Stdout
	}
	return o.out
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
	if o.JSON && !o.Validate {
		return fmt.Errorf("--json is only supported with --validate")
	}
	// The human preamble is noise in JSON mode: the document must be the whole
	// output so a caller can pipe it straight into a parser.
	if !o.JSON {
		fmt.Fprintf(o.w(), "db: total_art=%d  next_pid=%d  seq=%d  pack_off=%d  nd=%d  na=%d\n",
			core.TotalArticles, core.NextPackID, core.Seq, core.PackOffset, core.NumDeltas, core.DeltaArticles)
	}

	if core.TotalArticles == 0 {
		if o.JSON {
			enc := json.NewEncoder(o.w())
			enc.SetIndent("", "  ")
			return enc.Encode(map[string]any{"ok": true, "issues": []inspectIssue{}})
		}
		fmt.Fprintln(o.w(), "no articles")
		return nil
	}

	packs, deltas, err := loadIdxPacks(fetch, core)
	if err != nil {
		return err
	}
	if !o.JSON {
		for _, p := range packs {
			fmt.Fprintf(o.w(), "idx pack %d: %d entries, %d bounds (first=%+v last=%+v)\n",
				p.packIndex, p.packSize, len(p.bounds), p.bounds[0], p.bounds[len(p.bounds)-1])
		}
	}

	if o.Validate {
		return o.validateAll(fetch, core, packs, deltas)
	}
	if o.ListTags {
		return o.listTagsReport(core)
	}
	if o.FromHash != "" {
		return o.fromHashReport(fetch, core, packs, deltas, o.FromHash)
	}
	if o.Filter != "" {
		return o.filterReport(core, packs, o.Filter, o.Floor)
	}
	if o.Chron < 0 {
		fmt.Fprintln(o.w(), "(use --chron, --validate, --filter, --from-hash, or --list-tags)")
		return nil
	}
	return o.inspectOne(fetch, core, packs, deltas, o.Chron)
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
	// Validate integer fields that must be non-negative. A negative total_art
	// would reach idxKeyAndSize/parseIdxPack with a negative packSize and
	// panic with "makeslice: len out of range" (B8).
	if c.TotalArticles < 0 {
		return nil, fmt.Errorf("decode %s: total_art %d is negative", dbFileKey, c.TotalArticles)
	}
	if c.NextPackID < 0 {
		return nil, fmt.Errorf("decode %s: next_pid %d is negative", dbFileKey, c.NextPackID)
	}
	if c.PackOffset < 0 {
		return nil, fmt.Errorf("decode %s: pack_off %d is negative", dbFileKey, c.PackOffset)
	}
	if c.Seq < 0 {
		return nil, fmt.Errorf("decode %s: seq %d is negative", dbFileKey, c.Seq)
	}
	// A negative/oversized delta chain would reach loadDeltas/loadLatestIdx
	// with nonsense bounds; loadDeltas re-checks, but fail here with the same
	// clear decode framing as the fields above.
	if c.NumDeltas < 0 || c.NumDeltas > c.Seq {
		return nil, fmt.Errorf("decode %s: nd %d out of range [0, seq=%d]", dbFileKey, c.NumDeltas, c.Seq)
	}
	if c.DeltaArticles < 0 || c.DeltaArticles > c.TotalArticles {
		return nil, fmt.Errorf("decode %s: na %d out of range [0, total_art=%d]", dbFileKey, c.DeltaArticles, c.TotalArticles)
	}
	// Validate feed ids: feed_id is a u16 in each idx entry, so ids must be
	// in [0, feedIDCeiling). A hostile id >= feedIDCeiling reaches feedSlots
	// and parseIdxPack with slots = id+1, allocating ~4 GB per pack (B11).
	for id := range c.Feeds {
		if id < 0 || id >= feedIDCeiling {
			return nil, fmt.Errorf("decode %s: feed id %d out of range [0, %d]", dbFileKey, id, feedIDCeiling-1)
		}
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
