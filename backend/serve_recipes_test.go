package main

import (
	"context"
	"net/http"
	"testing"
)

func TestPutRecipe(t *testing.T) {
	setupTestDB(t)
	body := `{"ingest":"","pipe":["#sanitize","#minify"]}`
	rec := doReq(t, newMux(), "PUT", "/api/recipes/clean", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	if err := withDB(false, func(_ context.Context, d *DB) error {
		r, ok := d.core.Recipes["clean"]
		if !ok || len(r.Pipe) != 2 {
			t.Fatalf("recipe not stored: %+v", d.core.Recipes)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPutRecipeRejectsDefaultTokenInDefault(t *testing.T) {
	setupTestDB(t)
	body := `{"pipe":["#default"]}`
	rec := doReq(t, newMux(), "PUT", "/api/recipes/default", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteRecipeDefaultRefused(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "DELETE", "/api/recipes/default", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteRecipeReferencedRefused(t *testing.T) {
	setupTestDB(t)
	if err := withDB(true, func(ctx context.Context, d *DB) error {
		return setRecipe(ctx, d, "x", "", []string{"#minify"})
	}); err != nil {
		t.Fatal(err)
	}
	// Use a fresh withDB so the feed commit doesn't clobber the recipe written above.
	if err := withDB(true, func(ctx context.Context, d *DB) error {
		if err := d.AddFeed(&Feed{Title: "F", URL: "https://f.example/feed", Recipe: "x"}); err != nil {
			return err
		}
		return d.Commit(ctx)
	}); err != nil {
		t.Fatal(err)
	}

	rec := doReq(t, newMux(), "DELETE", "/api/recipes/x", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (referenced)", rec.Code)
	}
}

func TestDeleteRecipe(t *testing.T) {
	setupTestDB(t)
	if err := withDB(true, func(ctx context.Context, d *DB) error {
		return setRecipe(ctx, d, "tmp", "", []string{"#minify"})
	}); err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, newMux(), "DELETE", "/api/recipes/tmp", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
}
