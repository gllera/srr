package main

import (
	"bytes"
	"context"
	"slices"
	"strings"
	"testing"
)

// recipeSet runs `srr recipe set` against the test store.
func recipeSet(t *testing.T, name, ingest string, pipe ...string) error {
	t.Helper()
	cmd := &RecipeSetCmd{Name: name, Ingest: ingest, Pipe: pipe}
	return cmd.Run()
}

func TestRecipeSetUpsertAndShow(t *testing.T) {
	setupEmptyDB(t) // points globals.Store at a temp dir
	// #default is the composition token; recipes other than default may use it.
	if err := recipeSet(t, "read", "", "#readability", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	err := withDB(false, func(_ context.Context, db *DB) error {
		r := db.core.Recipes["read"]
		if !slices.Equal(r.Pipe, []string{"#readability", "#sanitize"}) {
			t.Errorf("read pipe = %v", r.Pipe)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestRecipeSetRejectsUnknownIngestBuiltin mirrors pipe validation on the ingest
// axis: a typo'd #-builtin must fail at `recipe set`, not silently dispatch as a
// shell command (`/bin/sh -c '#feeds'`) at fetch time and break every feed using
// the recipe.
func TestRecipeSetRejectsUnknownIngestBuiltin(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "foo", "#feeds", "#sanitize"); err == nil {
		t.Fatal("recipe set with ingest '#feeds' should be rejected")
	}
}

// TestRecipeSetTrimsIngest guards that surrounding whitespace is trimmed from
// the ingest override (an untrimmed ' #feed ' would dispatch as a shell command).
func TestRecipeSetTrimsIngest(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "foo", "  #feed  ", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if got := db.core.Recipes["foo"].Ingest; got != "#feed" {
			t.Errorf("ingest = %q, want %q (trimmed)", got, "#feed")
		}
		return nil
	})
}

func TestRecipeSetClearIngest(t *testing.T) {
	setupEmptyDB(t)
	_ = recipeSet(t, "tg", "srr-telegram", "#sanitize")
	if err := recipeSet(t, "tg", "", "#sanitize"); err != nil { // -i "" clears
		t.Fatalf("recipe set clear ingest: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if db.core.Recipes["tg"].Ingest != "" {
			t.Errorf("tg ingest = %q, want empty", db.core.Recipes["tg"].Ingest)
		}
		return nil
	})
}

func TestRecipeRmRefusesDefault(t *testing.T) {
	setupEmptyDB(t)
	if err := (&RecipeRmCmd{Name: defaultRecipeName}).Run(); err == nil {
		t.Error("recipe rm default accepted, want error")
	}
}

func TestRecipeRmRemoves(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "gone", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}
	if err := (&RecipeRmCmd{Name: "gone"}).Run(); err != nil {
		t.Fatalf("recipe rm: %v", err)
	}
	_ = withDB(false, func(_ context.Context, db *DB) error {
		if _, ok := db.core.Recipes["gone"]; ok {
			t.Error("recipe \"gone\" still present after rm")
		}
		return nil
	})
}

func TestRecipeSetDefaultRejectsDefaultToken(t *testing.T) {
	setupEmptyDB(t)
	// #default is forbidden inside the default recipe (it IS the default).
	if err := recipeSet(t, defaultRecipeName, "", "#default", "#minify"); err == nil {
		t.Error("recipe set default with #default accepted, want error")
	}
	// but allowed in any other recipe
	if err := recipeSet(t, "x", "", "#default"); err != nil {
		t.Errorf("recipe set x with #default rejected: %v", err)
	}
}

// RecipeLsCmd prints every recipe; RecipeShowCmd prints one and errors with a
// "not found" message on an unknown name.
func TestRecipeLsAndShow(t *testing.T) {
	setupEmptyDB(t)
	if err := recipeSet(t, "read", "", "#sanitize"); err != nil {
		t.Fatalf("recipe set: %v", err)
	}

	var out bytes.Buffer
	saved := stdout
	stdout = &out
	t.Cleanup(func() { stdout = saved })

	if err := (&RecipeLsCmd{Format: "json"}).Run(); err != nil {
		t.Fatalf("RecipeLsCmd: %v", err)
	}
	if !strings.Contains(out.String(), "read") || !strings.Contains(out.String(), defaultRecipeName) {
		t.Errorf("ls output missing recipes (read + default): %s", out.String())
	}

	out.Reset()
	if err := (&RecipeShowCmd{Name: "read", Format: "json"}).Run(); err != nil {
		t.Fatalf("RecipeShowCmd: %v", err)
	}
	if !strings.Contains(out.String(), "#sanitize") {
		t.Errorf("show output missing the recipe pipe: %s", out.String())
	}

	err := (&RecipeShowCmd{Name: "nope", Format: "json"}).Run()
	if err == nil || !strings.Contains(err.Error(), `recipe "nope" not found`) {
		t.Errorf("RecipeShowCmd(nope) = %v, want a 'recipe \"nope\" not found' error", err)
	}
}

func TestRecipeRmRefusesReferenced(t *testing.T) {
	setupEmptyDB(t)
	_ = recipeSet(t, "read", "", "#readability", "#default")
	_ = withDB(true, func(ctx context.Context, db *DB) error {
		if err := db.AddFeed(&Feed{Title: "T", URL: "http://example.com/rss", Recipe: "read"}); err != nil {
			return err
		}
		return db.Commit(ctx)
	})
	if err := (&RecipeRmCmd{Name: "read"}).Run(); err == nil {
		t.Error("recipe rm of a referenced recipe accepted, want error listing feed ids")
	}
}
