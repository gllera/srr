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
	"sync"
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
	q := r.URL.Query()
	dryRun := q.Get("dry_run") == "1"
	body, err := io.ReadAll(r.Body)
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

	// Read-only: InspectCmd.Run opens the store with NewDB(locked=false) and only
	// reads db.gz + packs, so /api/inspect never touches .locked (per the locking
	// contract). A store with no committed db.gz (a fresh, never-fetched dir)
	// surfaces as ok=false with the read error in the report — inspect must not
	// create db.gz as a side effect.
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
var serveStdoutMu sync.Mutex

func captureInspectStdout(fn func() error) (string, error) {
	serveStdoutMu.Lock()
	defer serveStdoutMu.Unlock()

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

	// Restore os.Stdout and close the pipe writer even if fn panics — otherwise a
	// panic in InspectCmd.Run would leave the whole process's stdout redirected to
	// a closed pipe and leak the reader goroutine. Closing wr here (before the
	// receive on out) signals EOF so the reader completes; an inner closure keeps
	// the close ordered before <-out on the normal path (a top-level defer would
	// deadlock, since <-out needs EOF first).
	runErr := func() error {
		defer func() {
			wr.Close()
			os.Stdout = orig
		}()
		return fn()
	}()
	return strings.TrimRight(<-out, "\n"), runErr
}
