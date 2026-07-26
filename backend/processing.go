package main

import (
	"context"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	// xhtml: the stdlib "html" above owns the unqualified name here.
	xhtml "golang.org/x/net/html"

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
//
// feedLang is the language the SOURCE declares for the whole feed
// (ingest.Result.Lang), the last resort of the language stamp below; "" when
// the source declares none, which is the common case.
func processItem(ctx context.Context, processor *mod.Module, pipeline []string, i *mod.RawItem, feedLang string) error {
	// One content session for the whole item: the always-on steps below and
	// every DOM-capable pipeline step share ONE parse of the content, and the
	// string is materialized only at a boundary (a string-form step, or the
	// normalization after the loop). See mod/session.go.
	sess := processor.NewSession(i)
	defer sess.Close()

	// Always-on URL normalization, BEFORE the pipeline: relative refs in the
	// feed's own markup resolve against the item's link, not the pack base the
	// reader would use (see absolutizeContent).
	absolutizeContent(sess, i.Link)
	// Always-on language stamp, BEFORE the pipeline so every step can read
	// i.Lang — #filter keep_lang consumes it instead of detecting on its own.
	// Precedence, strictly: a per-item declared Lang (the ingest strategy said
	// so about THIS item) > a confident detection > the feed's own declared
	// language. Detection reads the session's DOM (markup stripped), so raw
	// pre-sanitize content detects the same as clean text; its fail-open path
	// (short text, low confidence) leaves Lang empty.
	preTitle, preRev := i.Title, sess.Rev()
	if i.Lang == "" {
		i.Lang = mod.DetectLangNode(preTitle, sess.DOM())
	}
	// Last resort: what the feed declares about itself. Detection's gate is
	// deliberately conservative, so short microblog-style items — exactly the
	// ones a keep_lang pipe most needs a value for — routinely reach here
	// unstamped. Normalized through mod.NormalizeLangCode, which answers "" for
	// a tag that is not a code we recognize: a publisher's junk <language> must
	// stamp nothing rather than something confidently wrong. Remembered in
	// declaredLang so the post-pipe retry below can tell its own fallback from
	// a value a pipeline step chose.
	declaredLang := ""
	if i.Lang == "" {
		declaredLang = mod.NormalizeLangCode(feedLang)
		i.Lang = declaredLang
	}
	if len(pipeline) > 0 {
		GUID := i.GUID
		hadPub := i.Published != nil
		var pub time.Time
		if hadPub {
			pub = *i.Published
		}
		for _, m := range pipeline {
			if err := sess.Process(ctx, m); err != nil {
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
	// Materialize the DOM: everything below reads and rewrites the content
	// STRING. Close is idempotent, so the deferred one above becomes a no-op.
	sess.Close()
	i.Title = html.UnescapeString(titlePolicy.Sanitize(i.Title))
	i.Title = strings.Join(strings.Fields(strings.Map(stripControlKeepWS, i.Title)), " ")
	i.Link = strings.Map(stripControl, i.Link)
	i.Content = strings.Map(stripControlKeepWS, i.Content)
	// Second detection attempt, only when the pre-pipe pass came up empty and
	// the text it judged is no longer the text we hold — a step may have grown
	// the content past the gate (#readability replacing a short teaser with the
	// full article body).
	//
	// "Came up empty" includes an item still carrying the feed-declared
	// fallback: detection outranks it, so a step that grew the content must be
	// allowed to replace it. The value being ours is what the comparison
	// against declaredLang establishes — once a pipeline step has overridden
	// Lang, the item no longer holds a fallback and is left alone. And the
	// retry only overwrites on a real code: assigning unconditionally was safe
	// while the field could only be empty here, but it would now clear a good
	// fallback whenever the re-detection abstains too.
	//
	// The guard tracks whether DetectLang's exact INPUTS changed, not their
	// sizes. Skipping is then provably safe: DetectLang is a pure function of
	// (title, content), so unchanged inputs give the identical answer. A size
	// comparison is not safe in either direction — the gate is a rune count of
	// EXTRACTED TEXT, while bytes are mostly markup, so a byte-heavy text-poor
	// teaser replaced by a byte-light text-rich body is a genuine growth that
	// shrinks, and the retry that case exists for would be skipped.
	//
	// The content side is the session's mutation counter rather than a
	// before-image: holding one would force the pre-pipe materialization the
	// session exists to avoid. It counts a step that rewrote the content, so
	// it answers the same question — with one deliberate exclusion, the
	// control-character strip just above, which cannot change a classification
	// (control characters are not letters, and the detector folds whitespace).
	if (i.Lang == "" || i.Lang == declaredLang) && (i.Title != preTitle || sess.Rev() != preRev) {
		if code := mod.DetectLang(i.Title, i.Content); code != "" {
			i.Lang = code
		}
	}
	return nil
}

// absolutizeContent resolves relative URL references in the session's content
// against the item's own link. The reader resolves a relative reference
// against the PACK BASE, so a feed shipping src="/images/x.jpg" would
// otherwise publish a URL that 404s against the CDN forever — packs are
// immutable, there is no repair. Runs pre-pipeline (beside the lang stamp) so
// every step, #selfhost included, sees resolvable URLs; #readability replacing
// the content afterwards is fine, it absolutizes its own output. An unusable
// link, unparseable content, and a no-op pass all leave the content verbatim —
// it rewrites the session's DOM in place and reports the change, so nothing is
// re-rendered until a boundary needs the string.
func absolutizeContent(sess *mod.Session, link string) {
	base, err := url.Parse(strings.TrimSpace(link))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return
	}
	body := sess.DOM()
	if body == nil {
		return
	}
	changed := false
	visitAssetAttrs([]*xhtml.Node{body}, func(a *xhtml.Attribute) {
		v := strings.TrimSpace(a.Val)
		// "#" is both the ingest upload marker and an in-page fragment anchor;
		// "assets/" is a self-hosted key the reader resolves against the pack
		// base. Neither is a reference into the publisher's site.
		if v == "" || strings.HasPrefix(v, "#") || strings.HasPrefix(v, assetPrefix) {
			return
		}
		ref, err := url.Parse(v)
		if err != nil || ref.Scheme != "" {
			return // absolute (or unparseable) — leave it exactly as published
		}
		a.Val = base.ResolveReference(ref).String()
		changed = true
	})
	if changed {
		sess.Changed()
	}
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
