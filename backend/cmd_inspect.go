package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
)

// InspectCmd mirrors the frontend's bounds-based pack lookup so a pass
// here means the read path the browser uses is consistent with the pack
// files on disk. The idx parse + addressing mirror itself lives in
// idx_read.go (shared with `srr art`).
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

	// lister enumerates the store's own objects, set by openFetcher when the
	// inspected store can answer that at all. Nil for `--url` (an HTTP CDN read
	// through plain GETs) and for a store whose backend declines to list, which
	// is why the orphan report degrades to a skip rather than a failure.
	lister keyLister
}

// keyLister is the read-only half of store.Backend.List: keys under a prefix.
// Same contract — store-relative keys, lexicographic, an unmatched prefix is an
// empty slice and a nil error.
type keyLister func(prefix string) ([]string, error)

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
		fmt.Fprintf(o.w(), "db: v=%d  m=%d  total_art=%d  next_pid=%d  pack_off=%d  deltas=%d  na=%d\n",
			core.Version, core.ManifestNum, core.TotalArticles, core.NextPackID, core.PackOffset,
			core.numDeltas(), core.DeltaArticles)
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
		return cacheManifests(httpFetcher(ctx, o.URL)), nil, nil
	}
	db, err := NewDB(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	o.lister = func(prefix string) ([]string, error) {
		return db.List(ctx, prefix)
	}
	return cacheManifests(db.fetcher(ctx)), func() { db.Close(ctx) }, nil
}

// cacheManifests memoizes manifest bodies for ONE inspect run. --validate
// walks the same K-generation window three separate times — the M2 hole scan,
// the orphan reachability set and the chron-permanence check — and reads the
// current manifest again on top of the one loadCore already fetched, so on an
// --url store that is ~60 redundant GET+gunzip round-trips at the default K.
//
// Sound because manifest names are write-once and never reused (M3): inside a
// run a cached body cannot be stale. Only SUCCESSES are cached, so a missing
// generation is re-fetched and reported exactly as before, and only manifests
// are — the pack walks deliberately keep one resident pack rather than the
// whole store's content.
func cacheManifests(fetch keyGetter) keyGetter {
	// Guarded because a wrapped fetcher is handed to loadIdxPacks, which reads
	// the finalized packs concurrently: only manifest keys are ever stored, so
	// today no write races a read — but a memo whose safety depends on which
	// keys its callers happen to ask for is one refactor from a data race.
	var mu sync.Mutex
	cache := map[string][]byte{}
	return func(key string) ([]byte, error) {
		mu.Lock()
		buf, ok := cache[key]
		mu.Unlock()
		if ok {
			return buf, nil
		}
		buf, err := fetch(key)
		if err == nil && strings.HasPrefix(key, manifestSeries+"/") {
			mu.Lock()
			cache[key] = buf
			mu.Unlock()
		}
		return buf, err
	}
}

// httpFetcher reads store objects straight off a CDN for `srr inspect --url`.
// It carries the caller's context for the same reason the local-store branch of
// openFetcher threads it through db.readGz: --validate fetches every pack in
// the store, and half a fetcher honouring cancellation is not a property worth
// having. Today that context is Run's Background, so this is exactly the
// request net/http.Get built anyway.
func httpFetcher(ctx context.Context, base string) keyGetter {
	return func(key string) ([]byte, error) {
		u, err := url.JoinPath(base, key)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		res, err := http.DefaultClient.Do(req)
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

// loadCore resolves the store root exactly as the writer does — one resolver
// (root.go loadStore), so the checker can never disagree with the writer about
// what a store's objects are called. It range-checks the addressing integers on
// the way through (validateCore).
func loadCore(fetch keyGetter) (*DBCore, error) {
	return loadStore(fetch)
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
	// Runes, via the same cutter the MCP layer uses: a report line cut at a byte
	// offset can land mid-rune and print a replacement char, and the one caller
	// truncates a feed title.
	out, cut := truncateRunes(s, n)
	if cut {
		return out + "..."
	}
	return out
}
