package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"hash/fnv"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"time"

	"srr/store"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// SyncOutFeeds writes out/<name>.<ext> for every managed (non-External)
// OutFeed entry, collecting the newest-Limit articles whose feed id is in the
// union of tag-matched and explicitly-listed feed ids. External entries are
// push-updated slots this cycle must never write (see `srr syndicate push`) —
// they are skipped entirely. Called after SyncMeta and before Commit in the
// fetch cycle; warn-only — a syndication failure must NOT discard the article
// batch.
//
// Prerequisites: SRR_CDN_URL must be set (globals.CdnURL); without it the step
// is skipped with a warning (never a hard error) — unless there is nothing to
// generate, in which case the CDN check is skipped too (an all-external store
// needs no SRR_CDN_URL). Off by default: no managed out entries is a no-op.
func (o *DB) SyncOutFeeds(ctx context.Context) error {
	managed := o.managedOut()
	if len(managed) == 0 {
		// Nothing to generate. Deliberately BEFORE the CDN check: a store with
		// only external slots needs no SRR_CDN_URL and must not warn about it.
		return nil
	}
	cdn := globals.CdnURL
	if cdn == "" {
		slog.Warn("syndication enabled but SRR_CDN_URL unset; skipping out/* feeds")
		return nil
	}

	failed := 0
	for _, of := range managed {
		if err := o.syncOneOutFeed(ctx, of, cdn); err != nil {
			slog.Warn("sync out feed", "name", of.Name, "error", err)
			failed++
		}
	}
	// Report partial failure so the caller can leave lastOutSig unadvanced and
	// retry next cycle, instead of skipping the failed output until the signature
	// next changes. Still warn-only at the call site — the durable article batch
	// is never at risk.
	if failed > 0 {
		return fmt.Errorf("%d of %d syndication output(s) failed", failed, len(managed))
	}
	return nil
}

// outFeedsSig is a cheap, deterministic signature of the inputs that determine
// syndication output: the managed (non-External) out-feed config plus every
// feed's tag (a feed's tag change can alter which feeds a tag-scoped out feed
// includes) and AddIdx (an expiration-driven bump removes articles from the
// output, so it must un-gate the rewrite — a quiet store would otherwise serve
// expired items, pointing at deleted assets, forever). External entries are
// excluded — SyncOutFeeds never writes them, so their config edits must never
// un-gate a managed rewrite. cmd_fetch uses it to skip the SyncOutFeeds walk on
// a truly-idle cycle — no new articles AND an unchanged signature — without
// skipping config/tag edits made during the lock-free --interval sleep. Empty
// when no managed out feeds are configured.
func (o *DB) outFeedsSig() string {
	managed := o.managedOut()
	if len(managed) == 0 {
		return ""
	}
	var b strings.Builder
	_ = json.NewEncoder(&b).Encode(managed)
	for _, id := range slices.Sorted(maps.Keys(o.core.Feeds)) {
		fmt.Fprintf(&b, "%d=%s@%d;", id, o.core.Feeds[id].Tag, o.core.Feeds[id].AddIdx)
	}
	return b.String()
}

// managedOut returns the entries SyncOutFeeds generates — every non-External
// one. External entries are push-updated slots the fetch cycle must never
// write (see `srr syndicate push`); they are also excluded from outFeedsSig,
// so their config edits never un-gate a managed rewrite.
func (o *DB) managedOut() []OutFeed {
	var m []OutFeed
	for _, of := range o.core.Out {
		if !of.External {
			m = append(m, of)
		}
	}
	return m
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
	k := min(limit*scanMultiple, total)
	from := total - k

	// Collect all matches in the tail (oldest→newest via walkArticles), then
	// take the last `limit` to get the newest-first window. collect builds the
	// callback for one walk over [start, total): besides the tag/feed-id
	// selector it skips expired articles — chron < the feed's AddIdx
	// (retention bumped past them and deleted their assets, so emitting one
	// would syndicate 404s). Chron rides a counter beside the walk, like
	// ExpireArticles. The Feeds lookup is nil-safe for a deleted feed (already
	// excluded by the selector anyway).
	var matches []ArticleData
	collect := func(start int) func(*ArticleData) error {
		cur := start
		return func(ad *ArticleData) error {
			chron := cur
			cur++
			if !include[ad.FeedID] {
				return nil
			}
			if ch := o.core.Feeds[ad.FeedID]; ch != nil && chron < ch.AddIdx {
				return nil
			}
			cp := *ad
			matches = append(matches, cp)
			return nil
		}
	}
	if err := o.walkArticles(ctx, from, total, collect(from)); err != nil {
		return fmt.Errorf("walk articles for %q: %w", of.Name, err)
	}

	// The tail window didn't fill the limit — a sparse output. Resolve the rest
	// from the IDX series rather than re-scanning the whole data series: a
	// sparse output would otherwise re-read every data pack in the store on
	// essentially every dirty cycle, forever (the largest unbounded read
	// amplification left in the writer).
	if len(matches) < limit && from > 0 {
		var err error
		if matches, err = o.resolveOutWindow(ctx, include, limit); err != nil {
			return fmt.Errorf("resolve window for %q: %w", of.Name, err)
		}
	}

	// Take the newest `limit` items from the collected matches (matches is
	// already in oldest→newest order from walkArticles).
	if len(matches) > limit {
		matches = matches[len(matches)-limit:]
	}
	// Reverse to newest-first.
	slices.Reverse(matches)

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
	if err := o.AtomicPut(ctx, key, &buf, store.ObjectMeta{ContentType: outContentType(of)}); err != nil {
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
		ts := time.Unix(ad.displayTime(), 0).UTC().Format(time.RFC1123Z)

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
		ts := time.Unix(ad.displayTime(), 0).UTC().Format(time.RFC3339)

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
// Link: FNV-32a over "feedID:published:title".
func stableGUID(ad ArticleData) string {
	h := fnv.New32a()
	fmt.Fprintf(h, "%d:%d:%s", ad.FeedID, ad.Published, ad.Title)
	return fmt.Sprintf("urn:srr:%08x", h.Sum32())
}

// outAssetAttrs mirrors mod.assetAttrs: the element/attribute pairs whose
// values may contain relative asset references we need to CDN-prefix.
// We duplicate the list here rather than exporting it from mod to keep
// db_out.go self-contained.
var outAssetAttrs = map[string][]string{
	"img":   {"src"},
	"video": {"src", "poster"},
	"audio": {"src"},
	"a":     {"href"},
}

// parseBodyFragment parses content as an HTML body fragment. Callers treat a
// parse failure as "leave the content alone" — published content is immutable.
func parseBodyFragment(content string) ([]*html.Node, error) {
	return html.ParseFragment(strings.NewReader(content), &html.Node{
		Type:     html.ElementNode,
		Data:     "body",
		DataAtom: atom.Body,
	})
}

// visitAssetAttrs calls fn on each attribute in the outAssetAttrs
// element/attribute set, depth-first across nodes. Shared by rewriteAssetURLs
// (CDN-prefixing) and collectAssetRefs (expiration harvesting) so the two
// can't drift on which attributes carry asset keys.
func visitAssetAttrs(nodes []*html.Node, fn func(a *html.Attribute)) {
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if attrs, ok := outAssetAttrs[n.Data]; ok {
				for _, name := range attrs {
					for i := range n.Attr {
						if n.Attr[i].Key == name {
							fn(&n.Attr[i])
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	for _, n := range nodes {
		walk(n)
	}
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
	if !strings.Contains(content, assetPrefix) {
		return content, nil
	}
	nodes, err := parseBodyFragment(content)
	if err != nil {
		// Unparseable: leave untouched.
		return content, nil
	}
	changed := false
	visitAssetAttrs(nodes, func(a *html.Attribute) {
		// Only CDN-prefix self-hosted asset keys (flat
		// assets/<hex>/<hex>.ext) — never arbitrary relative URLs, or a
		// real relative <a href> would be repointed to the CDN host.
		if strings.HasPrefix(a.Val, assetPrefix) {
			a.Val = joinURL(cdn, a.Val)
			changed = true
		}
	})
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

// resolveOutWindow returns the newest `limit` articles matching include, in
// oldest→newest order (the shape the caller's newest-first reverse expects).
//
// It resolves the window from the idx series instead of scanning data/: idx
// entries are 2 bytes each (~2 MB at 1M articles) while the data series is
// hundreds of MB, and the old widen-to-full-store branch re-read ALL of it —
// fetch, gunzip and JSON-decode every pack — on essentially every dirty cycle,
// forever, for any output matching fewer than `limit` articles in the newest
// 500. Only the data packs actually holding a match are read here.
func (o *DB) resolveOutWindow(ctx context.Context, include map[int]bool, limit int) ([]ArticleData, error) {
	c := &o.core
	total := c.TotalArticles
	if total == 0 || limit <= 0 {
		return nil, nil
	}
	tc := tailCovered(c)
	slots := feedSlots(c)

	// An article counts when it belongs to the selection AND has not expired —
	// chron < the feed's AddIdx means retention bumped past it and deleted its
	// assets, so syndicating it would serve 404s. Nil-safe for a deleted feed
	// (already excluded by the selector anyway).
	live := func(chron, feedID int) bool {
		if !include[feedID] {
			return false
		}
		ch := c.Feeds[feedID]
		return ch == nil || chron >= ch.AddIdx
	}

	var out []ArticleData // newest→oldest while collecting

	// The delta region is resident (the chain is parsed once per cycle and
	// memoized), so it costs no extra store round-trip.
	if total > tc {
		deltas, err := o.loadDeltaArticles(ctx)
		if err != nil {
			return nil, err
		}
		for i := total - 1; i >= tc && len(out) < limit; i-- {
			if ad := deltas[i-tc]; live(i, ad.FeedID) {
				out = append(out, ad)
			}
		}
	}

	skip := o.outPackSkipper(ctx, include)

	// One data pack held open at a time. The walk descends through chrons, so
	// data pack ids descend monotonically and a single-slot cache hits nearly
	// always.
	var data []ArticleData
	dataPackID := -1
	article := func(pack *idxPack, chron int) (ArticleData, error) {
		packID, off := pack.getPackRef(chron)
		if packID != dataPackID {
			key := dataKeyFor(c, packID)
			raw, err := o.readGz(ctx, key)
			if err != nil {
				return ArticleData{}, err
			}
			if data, err = parseDataPack(raw); err != nil {
				return ArticleData{}, fmt.Errorf("parse %s: %w", key, err)
			}
			dataPackID = packID
		}
		if off >= len(data) {
			return ArticleData{}, fmt.Errorf("chron %d: offset %d beyond data pack %d (%d entries)", chron, off, packID, len(data))
		}
		return data[off], nil
	}

	for p := (tc - 1) / idxPackSize; p >= 0 && len(out) < limit; p-- {
		if tc == 0 {
			break
		}
		if skip(p) {
			continue
		}
		key, size := idxKeyAndSize(c, p)
		buf, err := o.readGz(ctx, key)
		if err != nil {
			return nil, err
		}
		pack, err := parseIdxPack(buf, p, size, slots)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		base := p * idxPackSize
		for i := min(size, tc-base) - 1; i >= 0 && len(out) < limit; i-- {
			chron := base + i
			if !live(chron, int(pack.feedIDs[i])) {
				continue
			}
			ad, err := article(pack, chron)
			if err != nil {
				return nil, err
			}
			out = append(out, ad)
		}
	}

	slices.Reverse(out) // → oldest→newest
	return out, nil
}

// outPackSkipper reports which finalized idx packs hold ZERO entries of the
// selected feeds and so need no fetch at all. It reads the header summary
// (idx/h<N>.gz) — the same per-pack cumulative counts the reader uses to skip
// packs during filtered navigation — plus the latest pack's header to close the
// last delta.
//
// The counts are all-time (writeIdxHeader sources them from the immutable
// per-feed totals), so a nonzero count does not prove an entry is still live —
// which is exactly why the skip is only ever taken on ZERO. Any problem reading
// the summary degrades to "never skip", never to a wrong answer.
func (o *DB) outPackSkipper(ctx context.Context, include map[int]bool) func(p int) bool {
	never := func(int) bool { return false }
	c := &o.core
	n := c.HdrPacks
	if n == 0 || n != numFinalizedIdx(c.TotalArticles) {
		return never // no summary, or it lags the finalized packs
	}

	cums := make([]*idxPack, n+1)
	buf, err := o.readGz(ctx, summaryKey(n))
	if err != nil {
		slog.Debug("out-feed pack skip unavailable", "error", err)
		return never
	}
	off := 0
	for k := range n {
		if off+idxHeaderPrefix > len(buf) {
			return never
		}
		numSlots := int(binary.LittleEndian.Uint32(buf[off+idxStateSize:]))
		end := off + idxHeaderPrefix + numSlots*4
		if end > len(buf) {
			return never
		}
		// Header-only decode (packSize 0 ⇒ no entries), so the ownFeedCounts
		// slot width is irrelevant.
		hdr, err := parseIdxPack(buf[off:end], k, 0, 0)
		if err != nil {
			return never
		}
		cums[k] = hdr
		off = end
	}
	// The cumulative counts AFTER the last finalized pack live in the latest
	// pack's header, which the summary (finalized packs only) does not carry.
	latestKey, _ := idxKeyAndSize(c, n)
	hbuf, err := o.readIdxHeader(ctx, latestKey)
	if err != nil {
		slog.Debug("out-feed pack skip unavailable", "error", err)
		return never
	}
	latest, err := parseIdxPack(hbuf, n, 0, 0)
	if err != nil {
		return never
	}
	cums[n] = latest

	return func(p int) bool {
		if p < 0 || p >= n {
			return false // the latest pack is always walked
		}
		for id := range include {
			if cums[p+1].feedCount(id) != cums[p].feedCount(id) {
				return false
			}
		}
		return true
	}
}
