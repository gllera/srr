package main

import (
	"context"
	"net/http"
)

func listSyndicate(w http.ResponseWriter, r *http.Request) {
	var out []OutFeed
	err := withDBCtx(r.Context(), false, func(_ context.Context, db *DB) error {
		out = append([]OutFeed(nil), db.core.Out...)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	if out == nil {
		out = []OutFeed{}
	}
	writeJSON(w, http.StatusOK, out)
}

func putSyndicate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title  string   `json:"title"`
		Format string   `json:"format"`
		Tags   []string `json:"tags"`
		Feeds  []int    `json:"feeds"`
		Limit  int      `json:"limit"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	entry := OutFeed{
		Name:   r.PathValue("name"),
		Title:  body.Title,
		Format: body.Format,
		Tags:   body.Tags,
		Feeds:  body.Feeds,
		Limit:  body.Limit,
	}
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, entry)
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func deleteSyndicate(w http.ResponseWriter, r *http.Request) {
	err := withDBCtx(r.Context(), true, func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, r.PathValue("name"))
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
