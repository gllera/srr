package main

import (
	"context"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"

	"srrb/mod"
)

var titlePolicy = bluemonday.StrictPolicy()

// processItem runs a RawItem through the module pipeline and then
// normalises Title/Link/Content. GUID and Published are immutable
// for every step in the pipeline; a change is reported as an error
// attributing the offending module.
func processItem(ctx context.Context, processor *mod.Module, pipeline []string, i *mod.RawItem) error {
	if len(pipeline) > 0 {
		GUID := i.GUID
		hadPub := i.Published != nil
		var pub time.Time
		if hadPub {
			pub = *i.Published
		}
		for _, m := range pipeline {
			if err := processor.Process(ctx, m, i); err != nil {
				return fmt.Errorf("module %q failed: %w", m, err)
			}
			if GUID != i.GUID {
				return fmt.Errorf("module %q changed GUID", m)
			}
			hasPub := i.Published != nil
			if hasPub != hadPub || (hasPub && !pub.Equal(*i.Published)) {
				return fmt.Errorf("module %q changed Published", m)
			}
		}
	}
	i.Title = html.UnescapeString(titlePolicy.Sanitize(i.Title))
	i.Title = strings.Join(strings.Fields(i.Title), " ")
	i.Link = strings.Map(stripControl, i.Link)
	i.Content = strings.Map(stripControlKeepWS, i.Content)
	return nil
}

// isC1 reports whether r is a C1 control (U+0080–U+009F). C1 controls have no
// printable glyph and no legitimate use in feed text, but survive #sanitize /
// #minify, so they would otherwise reach the reader (e.g. via a numeric ref
// like &#x9b;) and corrupt rendering or smuggle control bytes downstream.
func isC1(r rune) bool {
	return r >= 0x80 && r <= 0x9f
}

func stripControl(r rune) rune {
	if r <= ' ' || r == 0x7f || isC1(r) {
		return -1
	}
	return r
}

func stripControlKeepWS(r rune) rune {
	if (r < ' ' && r != '\t' && r != '\n' && r != '\r') || r == 0x7f || isC1(r) {
		return -1
	}
	return r
}

func validFeedURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme != "" && u.Host != ""
}
