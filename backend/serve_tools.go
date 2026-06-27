package main

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
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
	recipe := q.Get("recipe")
	if recipe == "" {
		recipe = defaultRecipeName
	}
	var items []*Item
	err := withDBCtx(r.Context(), false, func(ctx context.Context, db *DB) error {
		var e error
		items, e = renderPreview(ctx, db.core.Recipes, recipe, q["pipe"], q.Get("ingest"), rawURL)
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

func getGen(w http.ResponseWriter, r *http.Request) {
	var gen int
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		gen = db.core.Gen
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"gen": gen})
}

func bumpGen(w http.ResponseWriter, r *http.Request) {
	var gen int
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		db.BumpGen()
		gen = db.core.Gen
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"gen": gen})
}

func handleExport(w http.ResponseWriter, r *http.Request) {
	var data []byte
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		feeds := make([]*Feed, 0, len(db.Feeds()))
		for _, ch := range db.Feeds() {
			feeds = append(feeds, ch)
		}
		out, e := xml.MarshalIndent(buildOPML(feeds), "", "  ")
		if e != nil {
			return fmt.Errorf("encoding opml: %w", e)
		}
		data = append([]byte(xml.Header), out...)
		data = append(data, '\n')
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/x-opml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="srr-feeds.opml"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleImport imports every feed in the uploaded OPML body (like `srr import -a`).
// Optional query params: tag (override OPML group tags), recipe (stamp all),
// dry_run=1 (preview only). Subscribe-time discovery resolves homepage URLs.
func handleImport(w http.ResponseWriter, r *http.Request) {
	dryRun := r.URL.Query().Get("dry_run") == "1"
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, err)
		return
	}
	// ParseOPMLTree reads a path, so spill the body to a temp file.
	tmp, err := os.CreateTemp("", "srr-import-*.opml")
	if err != nil {
		writeErr(w, err)
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		writeErr(w, err)
		return
	}
	tmp.Close()

	nodes, err := ParseOPMLTree(tmp.Name())
	if err != nil {
		writeErr(w, err)
		return
	}
	iw := &importWalker{w: io.Discard, seen: map[string]bool{}}
	newFeeds, err := iw.walk(nodes, "", "", nil, true)
	if err != nil {
		writeErr(w, err)
		return
	}

	var tag, recipe *string
	if q := r.URL.Query(); q.Has("tag") {
		v := q.Get("tag")
		tag = &v
	}
	if q := r.URL.Query(); q.Has("recipe") {
		v := q.Get("recipe")
		recipe = &v
	}
	applyImportDefaults(newFeeds, recipe, tag)

	recipes, err := importRecipes()
	if err != nil {
		writeErr(w, err)
		return
	}
	if recipe != nil {
		if err := validateRecipeRef(recipes, *recipe); err != nil {
			writeErr(w, err)
			return
		}
	}
	kept, failed := resolveImportFeeds(r.Context(), newFeeds, recipes)

	type skip struct {
		Title string `json:"title"`
		URL   string `json:"url"`
		Error string `json:"error"`
	}
	skips := make([]skip, 0, len(failed))
	for _, f := range failed {
		skips = append(skips, skip{Title: f.Title, URL: f.URL, Error: f.Err.Error()})
	}

	if dryRun {
		previews := make([]feedView, 0, len(kept))
		for _, c := range kept {
			previews = append(previews, feedView{Title: c.Title, URL: c.URL, Tag: c.Tag, Recipe: c.Recipe})
		}
		writeJSON(w, http.StatusOK, map[string]any{"feeds": previews, "skipped": skips})
		return
	}

	err = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		for _, c := range kept {
			if err := normalizeFeed(c, db.core.Recipes); err != nil {
				return err
			}
			if err := db.AddFeed(c); err != nil {
				return err
			}
		}
		return db.Commit(ctx)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": len(kept), "skipped": skips})
}

// handleInspect runs `srr inspect` in-process for the supported GUI modes
// (validate, from-hash) and returns its textual report. It reuses InspectCmd by
// capturing os.Stdout for the call — the report functions print via fmt.Printf.
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

	// InspectCmd.Run reads db.gz via readGz (ignoreMissing=false). Commit the
	// current state first so db.gz is guaranteed to exist on disk. Best-effort:
	// if the store is locked by a running fetch the db.gz it maintains is current.
	_ = withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return db.Commit(ctx)
	})

	report, runErr := captureInspectStdout(func() error { return cmd.Run() })
	writeJSON(w, http.StatusOK, map[string]any{
		"report": report,
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

// captureInspectStdout redirects os.Stdout to a pipe for the duration of fn and
// returns what was written. Serialized by serveStdoutMu so concurrent inspect
// calls do not interleave (inspect is a rare, operator-driven action).
var serveStdoutMu = make(chan struct{}, 1)

func captureInspectStdout(fn func() error) (string, error) {
	serveStdoutMu <- struct{}{}
	defer func() { <-serveStdoutMu }()

	orig := os.Stdout
	rd, wr, err := os.Pipe()
	if err != nil {
		return "", err
	}
	os.Stdout = wr
	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(rd)
		out <- buf.String()
	}()

	runErr := fn()
	wr.Close()
	os.Stdout = orig
	return strings.TrimRight(<-out, "\n"), runErr
}
