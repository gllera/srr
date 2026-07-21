package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// previewArticle is the JSON shape GET /api/preview returns (decoupled from the
// internal Item type).
type previewArticle struct {
	Title     string `json:"title"`
	Link      string `json:"link"`
	Published int64  `json:"published"`
	Content   string `json:"content"`
}

func handlePreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rawURL := q.Get("url")
	if rawURL == "" {
		writeErr(w, fmt.Errorf("url is required"))
		return
	}
	var items []*Item
	err := withDBCtx(r.Context(), false, func(ctx context.Context, db *DB) error {
		var e error
		items, e = renderPreview(ctx, db.core.Recipes, q.Get("recipe"), q["pipe"], q.Get("ingest"), rawURL)
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	out := make([]previewArticle, 0, len(items))
	for _, i := range items {
		out = append(out, previewArticle{Title: i.Title, Link: i.Link, Published: i.Published, Content: i.Content})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleResolve probes a URL through a recipe's ingest without touching the
// store: GET /api/resolve?url=&recipe=&ingest= → {url, title, items} (ingest
// is the optional feed-level override, winning over the recipe's). The
// add-feed dialog calls it to read the wire's own label before the operator
// commits: the resolved feed URL (subscribe-time discovery folds a homepage to
// its advertised feed), the feed-level title, and the item count. Read-only
// and advisory — save re-resolves server-side, so a skipped or failed probe
// never blocks an add.
func handleResolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rawURL := q.Get("url")
	if !validFeedURL(rawURL) {
		writeErr(w, fmt.Errorf("invalid url %q", rawURL))
		return
	}
	var out map[string]any
	err := withDBCtx(r.Context(), false, func(ctx context.Context, db *DB) error {
		res, e := previewFetch(ctx, db.core.Recipes, q.Get("recipe"), q.Get("ingest"), rawURL)
		if e != nil {
			return e
		}
		resolved := res.ResolvedURL
		if resolved == "" {
			resolved = rawURL
		}
		out = map[string]any{"url": resolved, "title": res.Title, "items": len(res.Items)}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDedup sets the store-wide default seen.gz dedup horizon (db.gz
// DBCore.DedupDays), backing the Tools-tab control — the GUI twin of
// `srr dedup --days N`. Days in [0, 36500]; 0 resets to the built-in default.
// The store default has no off switch — a per-feed -1 disables the pool. Echoes
// the *effective* default so the UI re-displays the built-in after a 0 reset.
func handleDedup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Days int `json:"days"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := validateStoreDedupDays(body.Days); err != nil {
		writeErr(w, err)
		return
	}
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		db.core.DedupDays = body.Days
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"dedup_days": effectiveStoreDedup(body.Days)})
}

// handleExport serves the feed list as OPML (default, the interop format) or —
// with ?format=json — the LOSSLESS whole-configuration document `srr export`
// writes: OPML's leaf carries only title+url, so it is a backup that silently
// restores the wrong processing config.
func handleExport(w http.ResponseWriter, r *http.Request) {
	asJSON := r.URL.Query().Get("format") == "json"
	var data []byte
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		if asJSON {
			out, e := json.MarshalIndent(buildConfigDoc(db), "", "  ")
			if e != nil {
				return fmt.Errorf("encoding config: %w", e)
			}
			data = append(out, '\n')
			return nil
		}
		feeds := make([]*Feed, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			feeds = append(feeds, ch)
		}
		var e error
		data, e = opmlBytes(feeds)
		return e
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	if asJSON {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="srr-config.json"`)
	} else {
		w.Header().Set("Content-Type", "text/x-opml; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="srr-feeds.opml"`)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleImport imports every feed in the uploaded OPML body (like `srr import -a`).
// Optional query params: tag (override OPML group tags), recipe (stamp all),
// dry_run=1 (preview only). Subscribe-time discovery resolves homepage URLs.
// The webui only calls the dry run — its review sheet commits the operator's
// selection via POST /api/feeds/apply — but the commit path stays for direct
// API users wanting the one-shot import-all behavior.
func handleImport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dryRun := q.Get("dry_run") == "1"
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		writeErr(w, err)
		return
	}
	nodes, err := ParseOPMLBytes(body)
	if err != nil {
		writeErr(w, err)
		return
	}
	iw := &importWalker{w: io.Discard, seen: map[string]bool{}, tagOverride: q.Has("tag")}
	newFeeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		writeErr(w, err)
		return
	}

	var tag, recipe *string
	if q.Has("tag") {
		v := q.Get("tag")
		tag = &v
	}
	if q.Has("recipe") {
		v := q.Get("recipe")
		recipe = &v
	}
	kept, failed, err := resolveImportBatch(r.Context(), newFeeds, recipe, tag)
	if err != nil {
		writeErr(w, err)
		return
	}
	if failed == nil {
		failed = []importFailure{} // serialize as [] (the UI reads .skipped.length)
	}

	if dryRun {
		previews := make([]feedView, 0, len(kept))
		for _, c := range kept {
			previews = append(previews, feedView{Title: c.Title, URL: c.URL, Tag: c.Tag, Recipe: c.Recipe})
		}
		writeJSON(w, http.StatusOK, map[string]any{"feeds": previews, "skipped": failed})
		return
	}

	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return commitImportedFeeds(ctx, db, kept)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": len(kept), "skipped": failed})
}

// handleInspect runs `srr inspect` in-process for the supported GUI modes
// (validate, from-hash) and returns its textual report, collected through
// InspectCmd.out (a per-request buffer).
func handleInspect(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	cmd := &InspectCmd{}
	switch mode {
	case "validate":
		cmd.Validate = true
	case "from-hash":
		hash := r.URL.Query().Get("hash")
		if hash == "" {
			writeErr(w, fmt.Errorf("hash is required for mode=from-hash"))
			return
		}
		cmd.FromHash = hash
	default:
		writeErr(w, fmt.Errorf("unsupported mode %q (use validate or from-hash)", mode))
		return
	}

	// Read-only: InspectCmd.Run opens the store with NewDB(locked=false) and only
	// reads db.gz + packs, so /api/inspect never touches .locked (per the locking
	// contract). A store with no committed db.gz (a fresh, never-fetched dir)
	// surfaces as ok=false with the read error in the report — inspect must not
	// create db.gz as a side effect.
	// The report goes to a per-request buffer via InspectCmd.out — no swapping of
	// the process-global os.Stdout, so concurrent requests need no mutex and a
	// stray log line can never land in a caller's report.
	var report bytes.Buffer
	cmd.out = &report
	runErr := cmd.Run()
	writeJSON(w, http.StatusOK, map[string]any{
		"report": strings.TrimRight(report.String(), "\n"),
		"ok":     runErr == nil,
		"error":  errString(runErr),
	})
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
