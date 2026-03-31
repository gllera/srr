package main

import (
	"encoding/xml"
	"fmt"
	"net/url"
	"os"
	"strings"
)

type OPML struct {
	Body Body `xml:"body"`
}

type Body struct {
	Outlines []Outline `xml:"outline"`
}

type Outline struct {
	XMLURL   string    `xml:"xmlUrl,attr"`
	Title    string    `xml:"title,attr"`
	Text     string    `xml:"text,attr"`
	Outlines []Outline `xml:"outline"`
}

type OPMLNode struct {
	Name     string
	Sub      *Subscription
	Children []*OPMLNode
}

func outlineDisplayName(o Outline) string {
	if o.Title != "" {
		return o.Title
	}
	return o.Text
}

func outlineToSub(o Outline) *Subscription {
	u, err := url.Parse(o.XMLURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil
	}
	return &Subscription{Title: outlineDisplayName(o), URL: o.XMLURL}
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
		if s := outlineToSub(o); s != nil {
			node.Sub = s
		}
		if len(o.Outlines) > 0 {
			node.Children = buildTree(o.Outlines)
		}
		if node.Sub != nil || len(node.Children) > 0 {
			nodes = append(nodes, node)
		}
	}
	return nodes
}
