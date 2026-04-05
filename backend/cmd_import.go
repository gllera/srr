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
	Path   string   `arg:""    help:"Subscriptions opml file."`
	ID     []string `short:"i" help:"Ids to import."`
	All    bool     `short:"a" help:"Import all."`
	Tag    *string  `short:"g" help:"Tag to assign to imported subscriptions. Overrides OPML group tags."`
	DryRun bool     `short:"n" help:"Dry run. List resulting subscriptions without importing."`
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

	iw := &importWalker{w: w, selectedIDs: o.ID}
	newSubs, err := iw.walk(nodes, "", "", nil, o.All)
	if err != nil {
		return err
	}
	w.Flush()

	if len(newSubs) == 0 {
		return nil
	}

	// Resolve tags
	if o.Tag != nil {
		for _, s := range newSubs {
			s.Tag = *o.Tag
		}
	}

	if o.DryRun {
		w = tabwriter.NewWriter(os.Stdout, 1, 1, 2, ' ', 0)
		fmt.Fprintf(w, "\nTitle\tURL\tTag\n")
		fmt.Fprintf(w, "-----\t---\t---\n")
		for _, s := range newSubs {
			fmt.Fprintf(w, "%s\t%s\t%s\n", s.Title, s.URL, s.Tag)
		}
		w.Flush()
		return nil
	}

	ctx := context.Background()
	db, err := NewDB(ctx, true)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	for _, s := range newSubs {
		if err := db.AddSubscription(s); err != nil {
			return err
		}
	}

	return db.Commit(ctx)
}

type importWalker struct {
	w           io.Writer
	selectedIDs []string
}

func (iw *importWalker) walk(nodes []*OPMLNode, prefix, indent string, groupPath []string, importAll bool) ([]*Subscription, error) {
	sort.Slice(nodes, func(i, j int) bool {
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	var result []*Subscription

	selectSub := func(sub *Subscription) error {
		tag, err := resolveTag(groupPath)
		if err != nil {
			return err
		}
		sub.Tag = tag
		result = append(result, sub)
		return nil
	}

	for i, n := range nodes {
		id := prefix + strconv.Itoa(i+1)

		if n.Sub != nil && len(n.Children) == 0 {
			fmt.Fprintf(iw.w, "%s\t%s%s\t%s\n", id, indent, n.Name, n.Sub.URL)
			if iw.isSelected(id, importAll) {
				if err := selectSub(n.Sub); err != nil {
					return nil, err
				}
			}
		} else if len(n.Children) > 0 {
			fmt.Fprintf(iw.w, "%s\t%s[%s]\t-\n", id, indent, n.Name)

			if n.Sub != nil {
				subID := id + ".0"
				fmt.Fprintf(iw.w, "%s\t%s  %s\t%s\n", subID, indent, n.Name, n.Sub.URL)
				if iw.isSelected(subID, importAll) || iw.isSelected(id, false) {
					if err := selectSub(n.Sub); err != nil {
						return nil, err
					}
				}
			}

			childImportAll := importAll || iw.isSelected(id, false)
			childPath := append(append([]string{}, groupPath...), n.Name)
			subs, err := iw.walk(n.Children, id+".", indent+"  ", childPath, childImportAll)
			if err != nil {
				return nil, err
			}
			result = append(result, subs...)
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
