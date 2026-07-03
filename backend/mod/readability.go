package mod

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/andybalholm/cascadia"
	readability "github.com/go-shiori/go-readability"
	"golang.org/x/net/html"
)

// #readability fetches an item's Link and replaces Content with the article's
// main body extracted via readability. It exists for feeds that syndicate
// only a teaser/summary; placing "#readability" before "#sanitize" (e.g. a
// recipe pipe of "#readability #default") expands the body, then the usual
// sanitize/minify steps clamp the fetched HTML to the allowed element set.
//
// The module is fail-open: any problem (no link, unreachable origin,
// non-2xx, parse failure, empty extraction) leaves the original Content
// untouched and returns nil, so one bad article never fails the fetch.
// GUID/Published are not touched, satisfying the pipeline immutability rule.
//
// Four parameters tune the fetch per pipeline position (defaults below apply
// when omitted): "timeout" (Go duration, e.g. "30s"), "maxbody" (byte size,
// e.g. "16MiB"), "ua" (the request User-Agent — quote it, real UAs have
// spaces; the escape hatch for origins that block even the keyword-free
// default identity below), and "selector"
// (a CSS selector group; when set the matches' HTML — every match, document
// order, nested matches folded into their ancestor — replaces the readability
// heuristic entirely: the per-site escape hatch for pages whose genuine body
// is short while sidebar/widget chrome is text-dense, where the heuristic
// picks the wrong block, and via comma groups also for stitching disjoint
// blocks (hero image + body) into one article; a selector that matches
// nothing keeps the original content, it never falls back to the heuristic). A
// malformed or unknown parameter is a hard error — unlike the fail-open
// network path, a misconfigured pipe should surface immediately.
//   #readability timeout=30s ua="Mozilla/5.0 (compatible; SRR/1.0)" selector=div.entry-content

const (
	// readabilityTimeout is the default per-article fetch budget (override with
	// timeout=). Feed downloads use 10s; article pages (redirects, ads, slow
	// CMSes) need more headroom.
	readabilityTimeout = 20 * time.Second
	// readabilityMaxBody is the default downloaded-HTML cap (override with
	// maxbody=). readability only needs the document; an unbounded read would
	// let one page balloon worker memory.
	readabilityMaxBody = 8 << 20
	// readabilityUserAgent identifies the fetcher; some origins 403 the default
	// Go user agent, and keyword-scanning WAFs 406 scraper-sounding tokens
	// (blogdechollos.com blocks any UA containing "extractor" — the previous
	// "+full-text-extractor" suffix), so the identity stays honest but
	// keyword-free. Override per pipe with ua= for origins that block this too.
	readabilityUserAgent = "Mozilla/5.0 (compatible; SRR/1.0)"
)

func init() {
	Register("readability", func() Processor {
		// One client per Module (i.e. per fetch worker, via the procPool):
		// reused across the items a worker processes. The per-call timeout is
		// enforced via the request context rather than client.Timeout so it can
		// vary per pipeline position while sharing this client. The transport is
		// SSRF-guarded: the Link comes from attacker-controlled feed content, so
		// dials to private/loopback/link-local addresses are refused.
		client := &http.Client{Transport: SafeTransport()}
		// Compiled selector= values, keyed by their source string. Instances
		// are per fetch worker (procPool), so no locking; a pipe reuses one
		// selector across all its items, making this a one-entry cache in
		// practice.
		selCache := map[string]cascadia.SelectorGroup{}
		return func(ctx context.Context, p Params, i *RawItem) error {
			timeout, err := p.Duration("timeout", readabilityTimeout)
			if err != nil {
				return err
			}
			maxBody, err := p.Bytes("maxbody", readabilityMaxBody)
			if err != nil {
				return err
			}
			ua, err := p.String("ua", readabilityUserAgent)
			if err != nil {
				return err
			}
			var sel cascadia.SelectorGroup
			if s, ok := p["selector"]; ok {
				if sel = selCache[s]; sel == nil {
					if sel, err = cascadia.ParseGroup(s); err != nil {
						return fmt.Errorf("parameter selector=%q: %w", s, err)
					}
					selCache[s] = sel
				}
			}
			if err := p.only("timeout", "maxbody", "ua", "selector"); err != nil {
				return err
			}

			ctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			content, err := fetchReadable(ctx, client, i.Link, maxBody, ua, sel)
			if err != nil {
				slog.Warn("readability extraction failed; keeping original content",
					"link", i.Link, "err", err)
				return nil
			}
			if content != "" {
				i.Content = content
			}
			return nil
		}
	})
}

// fetchReadable downloads link and returns the extracted article HTML — the
// sel matches' concatenated HTML when sel is non-nil, the readability
// heuristic otherwise. It returns ("", nil) when there is nothing to extract
// (empty/invalid link or an empty result) and ("", err) on a fetch/parse
// failure or a selector miss, letting the caller distinguish "leave content
// as-is" from a genuine error worth logging.
func fetchReadable(ctx context.Context, client *http.Client, link string, maxBody int64, ua string, sel cascadia.SelectorGroup) (string, error) {
	if link == "" {
		return "", nil
	}
	u, err := url.Parse(link)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	body := io.LimitReader(resp.Body, maxBody)

	if sel != nil {
		return extractSelector(body, sel)
	}
	article, err := readability.FromReader(body, u)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(article.Content), nil
}

// extractSelector parses the document and returns the concatenated HTML of
// every node matching sel, in document order — so a comma group can pull
// disjoint blocks (hero image + article body) into one article. Each match
// contributes its inner HTML; a childless match (a void element like <img>)
// contributes the element itself, since its inner HTML is empty. A match
// nested inside an earlier match is already part of that block's content and
// is skipped, which also keeps fallback-style groups (two selectors naming
// the same node) emitting a single copy. A miss is an error (worth a WARN —
// it usually means a typo'd selector or a site redesign), never a fallback to
// the heuristic: selector= pins extraction precisely because the heuristic
// picks the wrong block on that site.
func extractSelector(r io.Reader, sel cascadia.SelectorGroup) (string, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return "", err
	}
	matches := cascadia.QueryAll(doc, sel) // pre-order walk: document order
	if len(matches) == 0 {
		return "", fmt.Errorf("selector matched nothing")
	}
	var b strings.Builder
	accepted := make(map[*html.Node]bool, len(matches))
	for _, n := range matches {
		nested := false
		for p := n.Parent; p != nil; p = p.Parent {
			if accepted[p] {
				nested = true
				break
			}
		}
		if nested {
			continue
		}
		accepted[n] = true
		if n.FirstChild == nil {
			if err := html.Render(&b, n); err != nil {
				return "", err
			}
			continue
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if err := html.Render(&b, c); err != nil {
				return "", err
			}
		}
	}
	return strings.TrimSpace(b.String()), nil
}
