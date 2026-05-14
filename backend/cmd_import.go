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
	Path    string    `arg:""                help:"Channels opml file."`
	ID      []string  `short:"i"             help:"Ids to import."`
	All     bool      `short:"a"             help:"Import all."`
	Tag     *string   `short:"g"             help:"Tag to assign to imported channels. Overrides OPML group tags."`
	DryRun  bool      `short:"n"             help:"Dry run. List resulting channels without importing."`
	Title   *string   `short:"t" optional:"" help:"Title for the merged channel. Triggers merge mode (all selections become one channel)."`
	Parsers *[]string `short:"p" optional:"" help:"Channel pipe applied to every imported channel. Repeatable. Empty (\"\") clears (inherit root)."`
	Ingest  *string   `          optional:"" help:"Channel ingest strategy applied to every imported channel. Empty (\"\") clears (inherit root)."`
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

	iw := &importWalker{w: w, selectedIDs: o.ID}
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
			fmt.Fprintf(w, "%s\t%s\t%s\n", c.Title, c.URLs(), c.Tag)
		}
		w.Flush()
		return nil
	}

	return withDB(true, func(ctx context.Context, db *DB) error {
		for _, c := range newChannels {
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
}

func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Channel, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Channel

	selectChannel := func(ch *Channel) error {
		tag, err := resolveTag(groupPath)
		if err != nil {
			return err
		}
		ch.Tag = tag
		result = append(result, ch)
		return nil
	}

	for i, n := range nodes {
		id := prefix + strconv.Itoa(i+1)

		if n.Channel != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Channel.URLs())
			if iw.isSelected(id, importAll) {
				if err := selectChannel(n.Channel); err != nil {
					return nil, err
				}
			}
		} else if len(n.Children) > 0 {
			fmt.Fprintf(iw.w, "%s\t%s[%s]\t-\n", id, indent, n.Name)

			if n.Channel != nil {
				chID := id + ".0"
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", chID, indent, n.Name, n.Channel.URLs())
				if iw.isSelected(chID, importAll) || iw.isSelected(id, false) {
					if err := selectChannel(n.Channel); err != nil {
						return nil, err
					}
				}
			}

			childImportAll := importAll || iw.isSelected(id, false)
			childPath := append(append([]string{}, groupPath...), n.Name)
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
// emitted by the importer. Each pointer is `nil` when the corresponding
// CLI flag is absent. parsers passes through filterPipe so empty entries
// drop and an all-empty input becomes nil (inherit-root semantics).
func applyImportDefaults(channels []*Channel, parsers *[]string, ingest, tag *string) {
	if parsers != nil {
		pipe := filterPipe(*parsers)
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
