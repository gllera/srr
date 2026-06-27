package main

import (
	"context"
	"fmt"
	"net/http"
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
