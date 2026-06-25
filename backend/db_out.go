package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"srrb/store"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// SyncOutFeeds writes out/<name>.<ext> for every OutFeed entry, collecting the
// newest-Limit articles whose feed id is in the union of tag-matched and
// explicitly-listed feed ids. Called after SyncMeta and before Commit in the
// fetch cycle; warn-only — a syndication failure must NOT discard the article
// batch.
//
// Prerequisites: SRR_CDN_URL must be set (globals.CdnURL); without it the step
// is skipped with a warning (never a hard error). Off by default: an empty
// core.Out slice is a no-op.
func (o *DB) SyncOutFeeds(ctx context.Context) error {
	if len(o.core.Out) == 0 {
		return nil
	}
	cdn := globals.CdnURL
	if cdn == "" {
		slog.Warn("syndication enabled but SRR_CDN_URL unset; skipping out/* feeds")
		return nil
	}

	for _, of := range o.core.Out {
		if err := o.syncOneOutFeed(ctx, of, cdn); err != nil {
			slog.Warn("sync out feed", "name", of.Name, "error", err)
		}
	}
	return nil
}

// outFeedsSig is a cheap, deterministic signature of the inputs that determine
// syndication output: the out-feed config plus every feed's tag (a feed's tag
// change can alter which feeds a tag-scoped out feed includes). cmd_fetch uses it
// to skip the SyncOutFeeds walk on a truly-idle cycle — no new articles AND an
// unchanged signature — without skipping config/tag edits made during the
// lock-free --interval sleep. Empty when no out feeds are configured.
func (o *DB) outFeedsSig() string {
	if len(o.core.Out) == 0 {
		return ""
	}
	var b strings.Builder
	_ = json.NewEncoder(&b).Encode(o.core.Out)
	ids := make([]int, 0, len(o.core.Feeds))
	for id := range o.core.Feeds {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		fmt.Fprintf(&b, "%d=%s;", id, o.core.Feeds[id].Tag)
	}
	return b.String()
}

// syncOneOutFeed collects and writes one syndication output file.
func (o *DB) syncOneOutFeed(ctx context.Context, of OutFeed, cdn string) error {
	// Defense-in-depth: reject unsafe names that bypassed the command gate
	// (e.g. a hand-edited or corrupted db.gz). The command gate uses validOutName
	// too, but a name stored in core.Out is deserialized directly and could
	// carry path components like "../../db" that would traverse out of out/ on
	// local or SFTP backends.
	if !validOutName(of.Name) {
		slog.Warn("skipping syndication output with unsafe name", "name", of.Name)
		return nil
	}

	// Build the set of feed ids to include.
	include := make(map[int]bool)
	for _, id := range of.Feeds {
		include[id] = true
	}
	for id, ch := range o.core.Feeds {
		for _, tag := range of.Tags {
			if tag == "" {
				continue // an empty tag would match every untagged feed
			}
			if ch.Tag == tag {
				include[id] = true
			}
		}
	}
	if len(include) == 0 {
		slog.Warn("syndication output has no matching feeds; skipping", "name", of.Name)
		return nil
	}

	limit := of.Limit
	if limit <= 0 {
		limit = outDefaultLimit
	}

	// Collect the newest-limit matching articles by walking a tail of the
	// store. We walk a window K = limit * scanMultiple (capped to
	// TotalArticles) to avoid a full store scan in the common case while still
	// filling the window even if only a fraction of articles match the filter.
	const scanMultiple = 10
	total := o.core.TotalArticles
	k := limit * scanMultiple
	if k > total {
		k = total
	}
	from := total - k

	// Collect all matches in the tail (oldest→newest via walkArticles), then
	// take the last `limit` to get the newest-first window.
	var matches []ArticleData
	err := o.walkArticles(ctx, from, total, func(ad *ArticleData) error {
		if include[ad.FeedID] {
			cp := *ad
			matches = append(matches, cp)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk articles for %q: %w", of.Name, err)
	}

	// If the scan window didn't fill the limit, widen to the full store.
	if len(matches) < limit && from > 0 {
		matches = nil
		if err := o.walkArticles(ctx, 0, total, func(ad *ArticleData) error {
			if include[ad.FeedID] {
				cp := *ad
				matches = append(matches, cp)
			}
			return nil
		}); err != nil {
			return fmt.Errorf("walk all articles for %q: %w", of.Name, err)
		}
	}

	// Take the newest `limit` items from the collected matches (matches is
	// already in oldest→newest order from walkArticles).
	if len(matches) > limit {
		matches = matches[len(matches)-limit:]
	}
	// Reverse to newest-first.
	for i, j := 0, len(matches)-1; i < j; i, j = i+1, j-1 {
		matches[i], matches[j] = matches[j], matches[i]
	}

	// Rewrite relative asset refs → absolute CDN URLs in each item's content.
	for i := range matches {
		rewritten, err := rewriteAssetURLs(matches[i].Content, cdn)
		if err != nil {
			slog.Warn("rewrite asset URLs", "name", of.Name, "err", err)
			// leave content as-is on error; don't fail the whole feed
		} else {
			matches[i].Content = rewritten
		}
	}

	// Serialize.
	var buf bytes.Buffer
	switch of.Format {
	case "json":
		if err := marshalJSONFeed(&buf, of, matches, cdn); err != nil {
			return fmt.Errorf("marshal JSON feed %q: %w", of.Name, err)
		}
	default: // "rss"
		if err := marshalRSS(&buf, of, matches, cdn); err != nil {
			return fmt.Errorf("marshal RSS feed %q: %w", of.Name, err)
		}
	}

	key := outFileKey(of)
	// AtomicPut (temp-then-rename) so a CDN reader never sees a truncated/half-
	// written feed — out/* is a mutable served object, like db.gz.
	if err := o.Backend.AtomicPut(ctx, key, &buf, store.ObjectMeta{}); err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// rssChannelXML is the XML structure for an RSS 2.0 channel element.
// We use a custom CDATA wrapper for item descriptions so HTML is preserved.
type rssChannelXML struct {
	XMLName  xml.Name     `xml:"channel"`
	Title    string       `xml:"title"`
	Link     string       `xml:"link"`
	AtomSelf rssAtomLink  `xml:"http://www.w3.org/2005/Atom link"`
	Desc     string       `xml:"description"`
	Items    []rssItemXML `xml:"item"`
}

type rssAtomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

// rssGUID is an RSS 2.0 <guid> with its isPermaLink attribute. A synthetic id
// (urn:srr:… for a linkless article) must set isPermaLink="false" so aggregators
// don't treat it as a clickable URL.
type rssGUID struct {
	Value       string `xml:",chardata"`
	IsPermaLink string `xml:"isPermaLink,attr"`
}

// rssItemXML holds one RSS 2.0 <item>.
type rssItemXML struct {
	Title   string      `xml:"title"`
	Link    string      `xml:"link,omitempty"`
	GUID    rssGUID     `xml:"guid"`
	PubDate string      `xml:"pubDate"`
	Desc    cdataString `xml:"description"`
}

// cdataString wraps a string in a CDATA section for XML serialization so HTML
// content is transmitted verbatim without entity-encoding.
type cdataString struct {
	Value string
}

func (c cdataString) MarshalXML(e *xml.Encoder, start xml.StartElement) error {
	// encoding/xml's ,cdata directive already splits any "]]>" terminator in the
	// value so the CDATA section stays well-formed. Pre-escaping it here too would
	// double-escape and corrupt content containing "]]>".
	return e.EncodeElement(struct {
		Value string `xml:",cdata"`
	}{c.Value}, start)
}

func marshalRSS(buf *bytes.Buffer, of OutFeed, items []ArticleData, cdn string) error {
	selfURL := joinURL(cdn, outFileKey(of))
	ch := rssChannelXML{
		Title:    outTitle(of),
		Link:     cdn,
		AtomSelf: rssAtomLink{Href: selfURL, Rel: "self", Type: "application/rss+xml"},
		Desc:     outTitle(of),
	}
	for _, ad := range items {
		pub := ad.Published
		if pub == 0 {
			pub = ad.FetchedAt
		}
		ts := time.Unix(pub, 0).UTC().Format(time.RFC1123Z)

		guid := rssGUID{Value: ad.Link, IsPermaLink: "true"}
		if ad.Link == "" {
			// Synthetic stable id (FeedID+Published, FNV-32a) — not a URL.
			guid = rssGUID{Value: stableGUID(ad), IsPermaLink: "false"}
		}

		ch.Items = append(ch.Items, rssItemXML{
			Title:   ad.Title,
			Link:    ad.Link,
			GUID:    guid,
			PubDate: ts,
			Desc:    cdataString{ad.Content},
		})
	}

	rss := struct {
		XMLName xml.Name `xml:"rss"`
		Version string   `xml:"version,attr"`
		Channel rssChannelXML
	}{
		Version: "2.0",
		Channel: ch,
	}

	buf.WriteString(xml.Header)
	enc := xml.NewEncoder(buf)
	enc.Indent("", "  ")
	if err := enc.Encode(rss); err != nil {
		return err
	}
	return enc.Flush()
}

// jsonFeedDoc is the JSON Feed 1.1 document shape.
type jsonFeedDoc struct {
	Version     string         `json:"version"`
	Title       string         `json:"title"`
	HomePageURL string         `json:"home_page_url,omitempty"`
	FeedURL     string         `json:"feed_url"`
	Items       []jsonFeedItem `json:"items"`
}

type jsonFeedItem struct {
	ID          string `json:"id"`
	URL         string `json:"url,omitempty"`
	Title       string `json:"title,omitempty"`
	ContentHTML string `json:"content_html"`
	DatePub     string `json:"date_published"`
}

func marshalJSONFeed(buf *bytes.Buffer, of OutFeed, items []ArticleData, cdn string) error {
	doc := jsonFeedDoc{
		Version:     "https://jsonfeed.org/version/1.1",
		Title:       outTitle(of),
		HomePageURL: cdn,
		FeedURL:     joinURL(cdn, outFileKey(of)),
		Items:       []jsonFeedItem{},
	}
	for _, ad := range items {
		pub := ad.Published
		if pub == 0 {
			pub = ad.FetchedAt
		}
		ts := time.Unix(pub, 0).UTC().Format(time.RFC3339)

		id := ad.Link
		if id == "" {
			id = stableGUID(ad)
		}

		doc.Items = append(doc.Items, jsonFeedItem{
			ID:          id,
			URL:         ad.Link,
			Title:       ad.Title,
			ContentHTML: ad.Content,
			DatePub:     ts,
		})
	}

	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(doc)
}

// stableGUID derives a stable string identifier for an article that has no
// Link, combining FeedID and Published via FNV-32a.
func stableGUID(ad ArticleData) string {
	// FNV-32a over "feedID:published:title" for stability.
	const offset32, prime32 = 2166136261, 16777619
	h := uint32(offset32)
	for _, b := range []byte(fmt.Sprintf("%d:%d:%s", ad.FeedID, ad.Published, ad.Title)) {
		h ^= uint32(b)
		h *= prime32
	}
	return fmt.Sprintf("urn:srr:%08x", h)
}

// outAssetAttrs mirrors mod.assetAttrs: the element/attribute pairs whose
// values may contain relative asset references we need to CDN-prefix.
// We duplicate the list here rather than exporting it from mod to keep
// db_out.go self-contained.
var outAssetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"a":     {"href"},
}

// rewriteAssetURLs rewrites relative attribute values (those not starting with
// a URL scheme or "//") in img/video src/poster and a href to absolute CDN
// URLs. Absolute values are left untouched. Returns original content on parse
// failure (unparseable HTML) — never an error in that case.
func rewriteAssetURLs(content, cdn string) (string, error) {
	if content == "" {
		return content, nil
	}
	// Fast path: no relative asset refs. We check for common relative prefixes.
	if !strings.Contains(content, "assets/") {
		return content, nil
	}

	nodes, err := html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
	if err != nil {
		// Unparseable: leave untouched.
		return content, nil
	}

	changed := false
	var walkNode func(*html.Node)
	walkNode = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if attrs, ok := outAssetAttrs[n.Data]; ok {
				for _, attrName := range attrs {
					for i := range n.Attr {
						if n.Attr[i].Key != attrName {
							continue
						}
						val := n.Attr[i].Val
						// Only CDN-prefix self-hosted asset keys (flat
						// assets/<hex>/<hex>.ext) — never arbitrary relative URLs, or a
						// real relative <a href> would be repointed to the CDN host.
						if strings.HasPrefix(val, "assets/") {
							n.Attr[i].Val = joinURL(cdn, val)
							changed = true
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walkNode(c)
		}
	}
	for _, n := range nodes {
		walkNode(n)
	}
	if !changed {
		return content, nil
	}
	var b strings.Builder
	for _, n := range nodes {
		if err := html.Render(&b, n); err != nil {
			return "", fmt.Errorf("render: %w", err)
		}
	}
	return b.String(), nil
}
