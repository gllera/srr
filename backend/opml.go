package main

import (
	"encoding/xml"
	"fmt"
	"os"
	"strings"
)

// OPML round-trips: Unmarshal ignores the extra export-side fields (XMLName
// matches loosely, version/head are simply read and discarded by import), and
// Marshal needs them to emit a spec-valid OPML 2.0 document for `feed export`.
type OPML struct {
	XMLName xml.Name `xml:"opml"`
	Version string   `xml:"version,attr"`
	Head    Head     `xml:"head"`
	Body    Body     `xml:"body"`
}

type Head struct {
	Title string `xml:"title,omitempty"`
}

type Body struct {
	Outlines []Outline `xml:"outline"`
}

type Outline struct {
	XMLURL   string    `xml:"xmlUrl,attr,omitempty"` // omitempty: group outlines carry no URL
	Title    string    `xml:"title,attr"`
	Text     string    `xml:"text,attr"`
	Outlines []Outline `xml:"outline"`
}

type OPMLNode struct {
	Name     string
	Feed     *Feed
	Children []*OPMLNode
}

func outlineDisplayName(o Outline) string {
	if o.Title != "" {
		return o.Title
	}
	return o.Text
}

func outlineToFeed(o Outline) *Feed {
	if !validFeedURL(o.XMLURL) {
		return nil
	}
	return &Feed{
		Title: outlineDisplayName(o),
		URL:   o.XMLURL,
	}
}

func normalizeGroupName(name string) (string, error) {
	var b strings.Builder
	hasNonDigit := false
	for _, r := range name {
		switch {
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
			hasNonDigit = true
		case r >= 'a' && r <= 'z', r == '_':
			b.WriteRune(r)
			hasNonDigit = true
		case r == '-', r == ' ':
			b.WriteRune('_')
			hasNonDigit = true
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		}
	}

	if b.Len() == 0 {
		return "", fmt.Errorf("group name is empty after normalization, use -g to override tag")
	}
	if !hasNonDigit {
		return "", fmt.Errorf("group name %q is numeric-only after normalization, use -g to override tag", name)
	}
	return b.String(), nil
}

func ParseOPMLTree(file string) ([]*OPMLNode, error) {
	var root OPML
	if b, err := os.ReadFile(file); err != nil {
		return nil, err
	} else if err = xml.Unmarshal(b, &root); err != nil {
		return nil, err
	}
	return buildTree(root.Body.Outlines), nil
}

func buildTree(outlines []Outline) []*OPMLNode {
	var nodes []*OPMLNode
	for _, o := range outlines {
		node := &OPMLNode{Name: outlineDisplayName(o)}
		if c := outlineToFeed(o); c != nil {
			node.Feed = c
		}
		if len(o.Outlines) > 0 {
			node.Children = buildTree(o.Outlines)
		}
		if node.Feed != nil || len(node.Children) > 0 {
			nodes = append(nodes, node)
		}
	}
	return nodes
}
