package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
)

type ImportCmd struct {
	Path    string   `arg:""                help:"Channels opml file."`
	ID      []string `short:"i"             help:"Ids to import."`
	All     bool     `short:"a"             help:"Import all."`
	Tag     *string  `short:"g"             help:"Tag to assign to imported channels. Overrides OPML group tags."`
	DryRun  bool     `short:"n"             help:"Dry run. List resulting channels without importing."`
	Title   *string  `short:"t" optional:"" help:"Title for the merged channel. Triggers merge mode (all selections become one channel)."`
	Parsers []string `short:"p" sep:"none" optional:"" help:"Channel pipe applied to every imported channel; repeat -p per step (not comma-separated). Empty (\"\") clears (inherit root)."`
	Ingest  *string  `          optional:"" help:"Channel ingest strategy applied to every imported channel. Empty (\"\") clears (inherit root)."`
}

func (o *ImportCmd) Run() error {
	if o.Title != nil {
		if *o.Title == "" {
			return fmt.Errorf("title must be non-empty")
		}
		if !o.All && len(o.ID) == 0 {
			return fmt.Errorf("merge requires -a or -i")
		}
	}

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

	iw := &importWalker{w: w, selectedIDs: o.ID, merge: o.Title != nil, tagOverride: o.Tag != nil}
	newChannels, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if iw.merge {
		if len(iw.mergedFeeds) == 0 {
			return nil
		}
		newChannels = []*Channel{{
			Title: *o.Title,
			Feeds: iw.mergedFeeds,
		}}
	}

	if len(newChannels) == 0 {
		return nil
	}

	applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)

	if o.DryRun {
		w = tabwriter.NewWriter(os.Stdout, 1, 1, 2, ' ', 0)
		fmt.Fprintf(w, "\nTitle\tURL\tTag\n")
		fmt.Fprintf(w, "-----\t---\t---\n")
		for _, c := range newChannels {
			fmt.Fprintf(w, "%s\t%s\t%s\n", c.Title, c.URLs(), c.Tag)
		}
		w.Flush()
		return nil
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		for _, c := range newChannels {
			if err := normalizeChannel(c); err != nil {
				return err
			}
			if err := db.AddChannel(c); err != nil {
				return err
			}
		}
		return db.Commit(ctx)
	})
}

type importWalker struct {
	w           io.Writer
	selectedIDs []string
	merge       bool    // true when -t is set; selected feeds accumulate into mergedFeeds instead of becoming channels
	tagOverride bool    // true when -g is set: skip OPML group-tag resolution. resolveTag can error on an un-normalizable group name, and applyImportDefaults overwrites Tag from -g regardless, so resolving here would only raise a spurious error.
	mergedFeeds []*Feed // accumulator (merge mode only)
}

func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Channel, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Channel

	// emit records a selected channel. path is the group path used to derive its
	// tag (skipped when -g overrides it). In merge mode feeds accumulate into one
	// channel, deduped by URL since OPML commonly lists the same xmlUrl in
	// several folders.
	emit := func(ch *Channel, path []string) error {
		if iw.merge {
			for _, f := range ch.Feeds {
				if slices.ContainsFunc(iw.mergedFeeds, func(e *Feed) bool { return e.URL == f.URL }) {
					continue
				}
				iw.mergedFeeds = append(iw.mergedFeeds, f)
			}
			return nil
		}
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

		if n.Channel != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Channel.URLs())
			if iw.isSelected(id, importAll) {
				if err := emit(n.Channel, groupPath); err != nil {
					return nil, err
				}
			}
		} else if len(n.Children) > 0 {
			fmt.Fprintf(iw.w, "%s\t%s[%s]\t-\n", id, indent, n.Name)
			childPath := append(append([]string{}, groupPath...), n.Name)

			if n.Channel != nil {
				chID := id + ".0"
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", chID, indent, n.Name, n.Channel.URLs())
				if iw.isSelected(chID, importAll) || iw.isSelected(id, false) {
					// A group that is also a feed: its own channel shares the tag
					// its children get (the group's own name), not the parent path.
					if err := emit(n.Channel, childPath); err != nil {
						return nil, err
					}
				}
			}

			childImportAll := importAll || iw.isSelected(id, false)
			channels, err := iw.walk(n.Children, id+".", indent+"  ", childPath, childImportAll)
			if err != nil {
				return nil, err
			}
			result = append(result, channels...)
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

// applyImportDefaults stamps Pipe / Ingest / Tag onto every channel
// emitted by the importer. parsers (a slice) and the ingest/tag pointers are
// `nil` when the corresponding CLI flag is absent. parsers passes through
// filterPipe so empty entries drop and an all-empty input becomes nil
// (inherit-root semantics).
func applyImportDefaults(channels []*Channel, parsers []string, ingest, tag *string) {
	if parsers != nil {
		pipe := filterPipe(parsers)
		for _, c := range channels {
			c.Pipe = pipe
		}
	}
	if ingest != nil {
		for _, c := range channels {
			c.Ingest = *ingest
		}
	}
	if tag != nil {
		for _, c := range channels {
			c.Tag = *tag
		}
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
