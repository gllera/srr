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

const (
	// readabilityTimeout bounds a single article fetch. Feed downloads use 10s;
	// article pages (redirects, ads, slow CMSes) need more headroom.
	readabilityTimeout = 20 * time.Second
	// readabilityMaxBody caps the downloaded HTML. readability only needs the
	// document; an unbounded read would let one page balloon worker memory.
	readabilityMaxBody = 8 << 20
	// readabilityUserAgent identifies the fetcher; some origins 403 the default
	// Go user agent, which would defeat extraction.
	readabilityUserAgent = "Mozilla/5.0 (compatible; SRR/1.0; +full-text-extractor)"
)

func init() {
	Register("readability", func(_ Assets) func(context.Context, *RawItem) error {
		// One client per Module (i.e. per fetch worker, via the procPool):
		// reused across the items a worker processes.
		client := &http.Client{Timeout: readabilityTimeout}
		return func(ctx context.Context, i *RawItem) error {
			content, err := fetchReadable(ctx, client, i.Link)
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
func fetchReadable(ctx context.Context, client *http.Client, link string) (string, error) {
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

	article, err := readability.FromReader(io.LimitReader(resp.Body, readabilityMaxBody), u)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(article.Content), nil
}
