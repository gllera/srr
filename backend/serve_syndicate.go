package main

import (
	"context"
	"net/http"
)

func putSyndicate(w http.ResponseWriter, r *http.Request) {
	var entry OutFeed
	if err := decodeJSON(r, &entry); err != nil {
		writeErr(w, err)
		return
	}
	entry.Name = r.PathValue("name") // the path is the authority for the name
	mutateStore(w, r, "ok", func(ctx context.Context, db *DB) error {
		return setOutFeed(ctx, db, entry)
	})
}

func deleteSyndicate(w http.ResponseWriter, r *http.Request) {
	mutateStore(w, r, "deleted", func(ctx context.Context, db *DB) error {
		return removeOutFeed(ctx, db, r.PathValue("name"))
	})
}
