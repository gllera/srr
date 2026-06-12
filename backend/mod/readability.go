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

	readability "github.com/go-shiori/go-readability"
)

// #readability fetches an item's Link and replaces Content with the article's
// main body extracted via readability. It exists for feeds that syndicate
// only a teaser/summary; placing "#readability" before "#sanitize" (e.g. a
// channel pipe of "#readability #base") expands the body, then the usual
// sanitize/minify steps clamp the fetched HTML to the allowed element set.
//
// The module is fail-open: any problem (no link, unreachable origin,
// non-2xx, parse failure, empty extraction) leaves the original Content
// untouched and returns nil, so one bad article never fails the fetch.
// GUID/Published are not touched, satisfying the pipeline immutability rule.
//
// Two parameters tune the fetch per pipeline position (defaults below apply
// when omitted): "timeout" (Go duration, e.g. "30s") and "maxbody" (byte size,
// e.g. "16MiB"). A malformed or unknown parameter is a hard error — unlike the
// fail-open network path, a misconfigured pipe should surface immediately.
//   #readability timeout=30s maxbody=16MiB

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
	// Go user agent, which would defeat extraction.
	readabilityUserAgent = "Mozilla/5.0 (compatible; SRR/1.0; +full-text-extractor)"
)

func init() {
	Register("readability", func(_ Assets) Processor {
		// One client per Module (i.e. per fetch worker, via the procPool):
		// reused across the items a worker processes. The per-call timeout is
		// enforced via the request context rather than client.Timeout so it can
		// vary per pipeline position while sharing this client. The transport is
		// SSRF-guarded: the Link comes from attacker-controlled feed content, so
		// dials to private/loopback/link-local addresses are refused.
		client := &http.Client{Transport: SafeTransport()}
		return func(ctx context.Context, p Params, i *RawItem) error {
			timeout, err := p.Duration("timeout", readabilityTimeout)
			if err != nil {
				return err
			}
			maxBody, err := p.Bytes("maxbody", readabilityMaxBody)
			if err != nil {
				return err
			}
			if err := p.only("timeout", "maxbody"); err != nil {
				return err
			}

			ctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			content, err := fetchReadable(ctx, client, i.Link, maxBody)
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

// fetchReadable downloads link and returns the readability-extracted article
// HTML. It returns ("", nil) when there is nothing to extract (empty/invalid
// link or an empty result) and ("", err) on a fetch/parse failure, letting the
// caller distinguish "leave content as-is" from a genuine error worth logging.
func fetchReadable(ctx context.Context, client *http.Client, link string, maxBody int64) (string, error) {
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
	req.Header.Set("User-Agent", readabilityUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	article, err := readability.FromReader(io.LimitReader(resp.Body, maxBody), u)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(article.Content), nil
}
