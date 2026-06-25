package main

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"

	"srrb/mod"
)

// RecipeGroup holds the `srr recipe` sub-commands. Recipes are named
// {ingest, pipe} bundles that feeds reference by name; the reserved "default"
// recipe is the fallback for every feed and is edited through the same
// `recipe set` path as any other.
type RecipeGroup struct {
	Ls   RecipeLsCmd   `cmd:"" help:"List all recipes."`
	Show RecipeShowCmd `cmd:"" help:"Print one recipe."`
	Set  RecipeSetCmd  `cmd:"" help:"Add or update a recipe."`
	Rm   RecipeRmCmd   `cmd:"" help:"Remove a recipe (refuses 'default' and recipes still referenced by a feed)."`
}

// RecipeLsCmd prints the whole recipes map as JSON/YAML.
type RecipeLsCmd struct {
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *RecipeLsCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		return printFormatted(o.Format, db.core.Recipes)
	})
}

// RecipeShowCmd prints one recipe; errors if it does not exist.
type RecipeShowCmd struct {
	Name   string `arg:"" help:"Recipe name."`
	Format string `short:"f" default:"json" enum:"yaml,json" help:"Output format."`
}

func (o *RecipeShowCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		r, ok := db.core.Recipes[o.Name]
		if !ok {
			return fmt.Errorf("recipe %q not found", o.Name)
		}
		return printFormatted(o.Format, r)
	})
}

// RecipeSetCmd upserts a recipe (full replace, like `srr syndicate set`): the
// stored recipe is exactly {Ingest from -i, Pipe from -p}. Pass both axes to
// set both. -i "" / no -p clear that axis (inherit default).
// Note: for "default" specifically, omitting -p clears the pipeline entirely —
// there is no fallback to inherit, so feeds using the default recipe will run
// with no pipeline until -p is set.
type RecipeSetCmd struct {
	Name   string   `arg:"" help:"Recipe name. 'default' is the reserved fallback recipe."`
	Ingest string   `short:"i" help:"Ingest strategy: built-in ('#feed') or shell command. Empty inherits the default recipe (⇒ #feed)."`
	Pipe   []string `short:"p" sep:"none" help:"Pipeline step; repeat -p per step (not comma-separated). #default expands to the default recipe's pipe (not allowed in 'default')."`
}

func (o *RecipeSetCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Name == "" {
			return fmt.Errorf("recipe name is required")
		}
		pipe := filterPipe(o.Pipe)
		// #default is allowed in every recipe except 'default' itself.
		if err := validatePipe(pipe, o.Name != defaultRecipeName); err != nil {
			return err
		}
		db.core.Recipes[o.Name] = Recipe{Ingest: o.Ingest, Pipe: pipe}
		return db.Commit(ctx)
	})
}

// RecipeRmCmd removes a recipe. Refuses to remove 'default', and refuses to
// strand feeds: a recipe still referenced by any feed errors with the
// referencing ids so the operator re-points them first.
type RecipeRmCmd struct {
	Name string `arg:"" help:"Recipe name to remove."`
}

func (o *RecipeRmCmd) Run() error {
	return withDB(true, func(ctx context.Context, db *DB) error {
		if o.Name == defaultRecipeName {
			return fmt.Errorf("cannot remove the reserved %q recipe", defaultRecipeName)
		}
		if _, ok := db.core.Recipes[o.Name]; !ok {
			return fmt.Errorf("recipe %q not found", o.Name)
		}
		var refs []int
		for id, ch := range db.Feeds() {
			if ch.Recipe == o.Name {
				refs = append(refs, id)
			}
		}
		if len(refs) > 0 {
			sort.Ints(refs)
			parts := make([]string, len(refs))
			for i, id := range refs {
				parts[i] = fmt.Sprint(id)
			}
			return fmt.Errorf("recipe %q is referenced by feed(s) %s; re-point them first", o.Name, strings.Join(parts, ", "))
		}
		delete(db.core.Recipes, o.Name)
		return db.Commit(ctx)
	})
}

// filterPipe trims each step and drops empty/whitespace-only entries. Returns
// nil when the result is empty so callers can use that as the "clear / inherit
// default" sentinel. Trimming matters: a whitespace-only step would otherwise
// be stored and later run as an empty `/bin/sh -c`, silently breaking a fetch.
func filterPipe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, m := range in {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// validatePipe rejects pipeline steps that would silently break a fetch: an
// unknown "#"-prefixed token (a typo'd built-in like "#sanitise"). "#default"
// is valid only in a non-default recipe (allowDefault); the default recipe is
// what it expands to, so it forbids self-reference. Run after filterPipe.
func validatePipe(steps []string, allowDefault bool) error {
	names := mod.Builtins()
	for _, s := range steps {
		fields := strings.Fields(s)
		if len(fields) == 0 {
			continue
		}
		name := fields[0]
		if name == pipeDefault {
			if !allowDefault {
				return fmt.Errorf("%q is not valid inside the %q recipe (it is the default)", pipeDefault, defaultRecipeName)
			}
			continue
		}
		if strings.HasPrefix(name, "#") && !slices.Contains(names, name) {
			return fmt.Errorf("unknown built-in module %q (known: %s)", name, strings.Join(names, ", "))
		}
	}
	return nil
}
