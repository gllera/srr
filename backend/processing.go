package main

import (
	"context"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"

	"srr/mod"
)

var titlePolicy = bluemonday.StrictPolicy()

// processItem runs a RawItem through the module pipeline and normalises
// Title/Link/Content, leaving the item store-ready. It is a pure, store-free
// transform: GUID and Published are immutable for every step in the pipeline,
// and a change is reported as an error attributing the offending module.
// The store-side asset-upload step (feed.fetch's inline upload step) is
// deliberately NOT here — it performs I/O and applies only on the fetch path,
// so feed.fetch runs it after this returns. Callers without a store (preview,
// tests) get the finished content directly.
func processItem(ctx context.Context, processor *mod.Module, pipeline []string, i *mod.RawItem) error {
	// Always-on language stamp, BEFORE the pipeline so every step can read
	// i.Lang — #filter keep_lang consumes it instead of detecting on its own.
	// A confident detection fills Lang unless the ingest strategy already
	// declared one; the fail-open path (short text, low confidence) leaves it
	// empty. extractText strips markup, so raw pre-sanitize content detects
	// the same as clean text.
	if i.Lang == "" {
		i.Lang = mod.DetectLang(i.Title, i.Content)
	}
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
			// A drop signal short-circuits the remaining steps and skips
			// post-loop normalization — a dropped item is never stored, so
			// normalizing its fields is wasteful and misleading.
			if i.Drop {
				return nil
			}
		}
	}
	i.Title = html.UnescapeString(titlePolicy.Sanitize(i.Title))
	i.Title = strings.Join(strings.Fields(strings.Map(stripControlKeepWS, i.Title)), " ")
	i.Link = strings.Map(stripControl, i.Link)
	i.Content = strings.Map(stripControlKeepWS, i.Content)
	// Second detection attempt, only when the pre-pipe pass came up empty: a
	// step may have grown the content past the gate (#readability replacing a
	// short teaser with the full article body). Already-stamped items skip it.
	if i.Lang == "" {
		i.Lang = mod.DetectLang(i.Title, i.Content)
	}
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
