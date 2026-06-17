package main

import (
	"context"
	"encoding/xml"
	"fmt"
	"sort"
	"strings"
)

// ExportCmd writes the channel list as an OPML 2.0 document — the inverse of
// `chan import`: hierarchical tags become nested outline groups, untagged
// channels sit at the body top level, and each channel emits one leaf carrying
// its single URL. Stored tags are already normalized (normalizeGroupName is
// idempotent on its own output), so `export | import -a` reproduces identical
// tags.
type ExportCmd struct {
	Tag *string `short:"g" optional:"" help:"Only export channels with this exact tag."`
}

func (o *ExportCmd) Run() error {
	return withDB(false, func(_ context.Context, db *DB) error {
		chans := make([]*Channel, 0, len(db.Channels()))
		for _, ch := range db.Channels() {
			if o.Tag != nil && ch.Tag != *o.Tag {
				continue
			}
			chans = append(chans, ch)
		}
		out, err := xml.MarshalIndent(buildOPML(chans), "", "  ")
		if err != nil {
			return fmt.Errorf("encoding opml: %w", err)
		}
		_, err = fmt.Fprintf(stdout, "%s%s\n", xml.Header, out)
		return err
	})
}

// exportNode is one tag segment's group. Children are keyed by segment so
// channels sharing a tag prefix (tech/go_blogs, tech/rust) merge into the
// same group node.
type exportNode struct {
	children map[string]*exportNode
	channels []*Channel
}

func newExportNode() *exportNode {
	return &exportNode{children: map[string]*exportNode{}}
}

func buildOPML(chans []*Channel) OPML {
	sort.Slice(chans, func(i, j int) bool {
		return strings.ToLower(chans[i].Title) < strings.ToLower(chans[j].Title)
	})
	root := newExportNode()
	for _, ch := range chans {
		node := root
		if ch.Tag != "" {
			for _, seg := range strings.Split(ch.Tag, "/") {
				child := node.children[seg]
				if child == nil {
					child = newExportNode()
					node.children[seg] = child
				}
				node = child
			}
		}
		node.channels = append(node.channels, ch)
	}
	return OPML{
		Version: "2.0",
		Head:    Head{Title: "SRR channels"},
		Body:    Body{Outlines: outlinesOf(root)},
	}
}

// outlinesOf emits a node's group children (sorted by name) followed by its
// channel leaves (already title-sorted by buildOPML) — one leaf per channel,
// carrying its single xmlUrl.
func outlinesOf(n *exportNode) []Outline {
	names := make([]string, 0, len(n.children))
	for name := range n.children {
		names = append(names, name)
	}
	sort.Strings(names)
	outs := make([]Outline, 0, len(names)+len(n.channels))
	for _, name := range names {
		outs = append(outs, Outline{Title: name, Text: name, Outlines: outlinesOf(n.children[name])})
	}
	for _, ch := range n.channels {
		outs = append(outs, Outline{Title: ch.Title, Text: ch.Title, XMLURL: ch.URL})
	}
	return outs
}
