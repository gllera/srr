package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestListRecipes(t *testing.T) {
	setupTestDB(t)
	rec := doReq(t, newMux(), "GET", "/api/recipes", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]Recipe
	json.Unmarshal(rec.Body.Bytes(), &got)
	if _, ok := got["default"]; !ok {
		t.Fatalf("default recipe missing: %+v", got)
	}
}

func TestPutRecipe(t *testing.T) {
	setupTestDB(t)
	body := `{"ingest":"","pipe":["#sanitize","#minify"]}`
	rec := doReq(t, newMux(), "PUT", "/api/recipes/clean", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body)
	}
	withDB(false, func(_ context.Context, d *DB) error {
		r, ok := d.core.Recipes["clean"]
		if !ok || len(r.Pipe) != 2 {
			t.Fatalf("recipe not stored: %+v", d.core.Recipes)
		}
		return nil
	})
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
