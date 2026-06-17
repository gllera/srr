package main

import (
	"context"
	"fmt"
	"io"
	"os"
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
	Parsers []string `short:"p" sep:"none" optional:"" help:"Channel pipe applied to every imported channel; repeat -p per step (not comma-separated). Empty (\"\") clears (inherit root)."`
	Ingest  *string  `          optional:"" help:"Channel ingest strategy applied to every imported channel. Empty (\"\") clears (inherit root)."`
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
	newChannels, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if len(newChannels) == 0 {
		return nil
	}

	applyImportDefaults(newChannels, o.Parsers, o.Ingest, o.Tag)

	if o.DryRun {
		w = tabwriter.NewWriter(os.Stdout, 1, 1, 2, ' ', 0)
		fmt.Fprintf(w, "\nTitle\tURL\tTag\n")
		fmt.Fprintf(w, "-----\t---\t---\n")
		for _, c := range newChannels {
			fmt.Fprintf(w, "%s\t%s\t%s\n", c.Title, c.URL, c.Tag)
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
	tagOverride bool            // true when -g is set: skip OPML group-tag resolution. resolveTag can error on an un-normalizable group name, and applyImportDefaults overwrites Tag from -g regardless, so resolving here would only raise a spurious error.
	seen        map[string]bool // URLs already emitted: OPML commonly cross-lists the same xmlUrl in several folders, so dedup to one channel (first folder wins its tag).
}

func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Channel, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Channel

	// emit records a selected channel. path is the group path used to derive its
	// tag (skipped when -g overrides it). The same xmlUrl is commonly cross-listed
	// in several folders, so a URL already emitted is skipped (first folder wins
	// its tag) — exactly one channel per distinct URL.
	emit := func(ch *Channel, path []string) error {
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

		if n.Channel != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Channel.URL)
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
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", chID, indent, n.Name, n.Channel.URL)
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
// emitted by the importer. parsers (a slice) and the ingestStrategy/tag pointers are
// `nil` when the corresponding CLI flag is absent. parsers passes through
// filterPipe so empty entries drop and an all-empty input becomes nil
// (inherit-root semantics).
func applyImportDefaults(channels []*Channel, parsers []string, ingestStrategy, tag *string) {
	if parsers != nil {
		pipe := filterPipe(parsers)
		for _, c := range channels {
			c.Pipe = append([]string(nil), pipe...)
		}
	}
	if ingestStrategy != nil {
		for _, c := range channels {
			c.Ingest = *ingestStrategy
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
