package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"text/tabwriter"
)

type ImportCmd struct {
	Path   string   `arg:""                help:"Feeds opml file."`
	ID     []string `short:"i"             help:"Ids to import."`
	All    bool     `short:"a"             help:"Import all."`
	Tag    *string  `short:"g"             help:"Tag to assign to imported feeds. Overrides OPML group tags."`
	DryRun bool     `short:"n"             help:"Dry run. List resulting feeds without importing."`
	Recipe *string  `short:"r" optional:"" help:"Recipe name applied to every imported feed (must exist). Empty (\"\") clears (⇒ default)."`
}

func (o *ImportCmd) Run() error {
	nodes, err := ParseOPMLTree(o.Path)
	if err != nil {
		return err
	}

	var output io.Writer = os.Stdout
	if !o.DryRun && (o.All || len(o.ID) > 0) {
		output = io.Discard
	}
	w := tabwriter.NewWriter(output, 1, 1, 2, ' ', 0)

	fmt.Fprintf(w, "ID\tTitle\tURL\n")
	fmt.Fprintf(w, "---\t-----\t---\n")

	iw := &importWalker{w: w, selectedIDs: o.ID, tagOverride: o.Tag != nil, seen: map[string]bool{}}
	newFeeds, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if len(newFeeds) == 0 {
		return nil
	}

	applyImportDefaults(newFeeds, o.Recipe, o.Tag)

	// Subscribe-time discovery gate reads the recipes map (read-only).
	recipes, err := importRecipes()
	if err != nil {
		return err
	}
	kept, failed := resolveImportFeeds(context.Background(), newFeeds, recipes)
	reportImportFailures(failed)

	if o.DryRun {
		w = tabwriter.NewWriter(os.Stdout, 1, 1, 2, ' ', 0)
		fmt.Fprintf(w, "\nTitle\tURL\tTag\n")
		fmt.Fprintf(w, "-----\t---\t---\n")
		for _, c := range kept {
			fmt.Fprintf(w, "%s\t%s\t%s\n", c.Title, c.URL, c.Tag)
		}
		w.Flush()
		return nil
	}

	if len(kept) == 0 {
		return nil
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
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
}

type importWalker struct {
	w           io.Writer
	selectedIDs []string
	tagOverride bool            // true when -g is set: skip OPML group-tag resolution. resolveTag can error on an un-normalizable group name, and applyImportDefaults overwrites Tag from -g regardless, so resolving here would only raise a spurious error.
	seen        map[string]bool // URLs already emitted: OPML commonly cross-lists the same xmlUrl in several folders, so dedup to one feed (first folder wins its tag).
}

func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Feed, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Feed

	// emit records a selected feed. path is the group path used to derive its
	// tag (skipped when -g overrides it). The same xmlUrl is commonly cross-listed
	// in several folders, so a URL already emitted is skipped (first folder wins
	// its tag) — exactly one feed per distinct URL.
	emit := func(ch *Feed, path []string) error {
		if iw.seen[ch.URL] {
			return nil
		}
		iw.seen[ch.URL] = true
		if !iw.tagOverride {
			tag, err := resolveTag(path)
			if err != nil {
				return err
			}
			ch.Tag = tag
		}
		result = append(result, ch)
		return nil
	}

	for i, n := range nodes {
		id := prefix + strconv.Itoa(i+1)

		if n.Feed != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Feed.URL)
			if iw.isSelected(id, importAll) {
				if err := emit(n.Feed, groupPath); err != nil {
					return nil, err
				}
			}
		} else if len(n.Children) > 0 {
			fmt.Fprintf(iw.w, "%s\t%s[%s]\t-\n", id, indent, n.Name)
			childPath := append(append([]string{}, groupPath...), n.Name)

			if n.Feed != nil {
				chID := id + ".0"
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", chID, indent, n.Name, n.Feed.URL)
				if iw.isSelected(chID, importAll) || iw.isSelected(id, false) {
					// A group that is also a feed: its own feed shares the tag
					// its children get (the group's own name), not the parent path.
					if err := emit(n.Feed, childPath); err != nil {
						return nil, err
					}
				}
			}

			childImportAll := importAll || iw.isSelected(id, false)
			feeds, err := iw.walk(n.Children, id+".", indent+"  ", childPath, childImportAll)
			if err != nil {
				return nil, err
			}
			result = append(result, feeds...)
		}
	}

	return result, nil
}

func (iw *importWalker) isSelected(id string, importAll bool) bool {
	if importAll {
		return true
	}
	for _, sel := range iw.selectedIDs {
		if strings.HasPrefix(id+".", sel+".") {
			return true
		}
	}
	return false
}

// applyImportDefaults stamps Recipe / Tag onto every imported feed. recipe and
// tag pointers are nil when the corresponding CLI flag is absent.
func applyImportDefaults(feeds []*Feed, recipe, tag *string) {
	if recipe != nil {
		for _, c := range feeds {
			c.Recipe = *recipe
		}
	}
	if tag != nil {
		for _, c := range feeds {
			c.Tag = *tag
		}
	}
}

// importFailure records a feed whose URL could not be resolved to a feed at
// subscribe time, so it is skipped (and reported) rather than aborting the batch.
type importFailure struct {
	Title string
	URL   string
	Err   error
}

// resolveImportFeeds runs subscribe-time discovery over the import set: feeds
// whose effective ingest is the built-in #feed are probed concurrently (a
// homepage URL is repointed to its discovered <link rel=alternate> feed),
// external-ingest feeds pass through untouched. It returns the feeds to import
// (with resolved URLs) and the ones that could not be resolved — import is
// partial-success, not all-or-nothing.
func resolveImportFeeds(ctx context.Context, feeds []*Feed, recipes map[string]Recipe) (kept []*Feed, failed []importFailure) {
	resolved := make([]string, len(feeds))
	errs := make([]error, len(feeds))

	sem := make(chan struct{}, max(1, globals.Workers))
	var wg sync.WaitGroup
	for i, c := range feeds {
		if !resolvesFeed(recipes, c.Recipe) {
			resolved[i] = c.URL // external ingest: stored as-is, never probed
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, url string) {
			defer wg.Done()
			defer func() { <-sem }()
			resolved[i], errs[i] = resolveFeedURL(ctx, url)
		}(i, c.URL)
	}
	wg.Wait()

	for i, c := range feeds {
		if errs[i] != nil {
			failed = append(failed, importFailure{Title: c.Title, URL: c.URL, Err: errs[i]})
			continue
		}
		c.URL = resolved[i]
		kept = append(kept, c)
	}
	return kept, failed
}

// importRecipes reads the db.gz recipes map (read-only, unlocked) so
// resolveImportFeeds can resolve each feed's recipe to gate #feed discovery.
func importRecipes() (map[string]Recipe, error) {
	var recipes map[string]Recipe
	err := withDB(false, func(_ context.Context, db *DB) error {
		recipes = db.core.Recipes
		return nil
	})
	return recipes, err
}

// reportImportFailures prints the feeds skipped because no feed could be
// resolved at their URL, to the (test-overridable) stdout.
func reportImportFailures(failed []importFailure) {
	if len(failed) == 0 {
		return
	}
	fmt.Fprintf(stdout, "\nSkipped %d feed(s) — no feed found at the URL:\n", len(failed))
	for _, f := range failed {
		fmt.Fprintf(stdout, "  %s\t%s\t%v\n", f.Title, f.URL, f.Err)
	}
}

func resolveTag(groupPath []string) (string, error) {
	if len(groupPath) == 0 {
		return "", nil
	}

	parts := make([]string, len(groupPath))
	for i, p := range groupPath {
		n, err := normalizeGroupName(p)
		if err != nil {
			return "", err
		}
		parts[i] = n
	}
	return strings.Join(parts, "/"), nil
}
