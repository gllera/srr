package ingest

import (
	"strings"
	"testing"

	"srr/mod"
)

// ParseFeed is the one function in SRR that chews raw bytes from the open
// internet, on every feed, every five minutes, in the process that holds the
// store lock — so a panic here is not a crashed parse, it is a fetch loop that
// stops fetching. It is also, deliberately, a LENIENT parser (non-strict XML,
// HTML entities, charset transcoding), and leniency is where parsers grow
// unbounded reads and nil derefs.
//
// The target asserts the two things the caller relies on: it always returns
// instead of panicking, and every item it streams is safe to store.
func FuzzParseFeed(f *testing.F) {
	f.Add(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>` +
		`<item><title>A</title><link>https://e.example/a</link><guid>a</guid>` +
		`<pubDate>Mon, 02 Jan 2006 15:04:05 -0700</pubDate></item></channel></rss>`)
	f.Add(`<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>` +
		`<entry><title>A</title><link href="https://e.example/a"/><id>a</id>` +
		`<updated>2006-01-02T15:04:05Z</updated></entry></feed>`)
	f.Add(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item><title>A</title></item></rdf:RDF>`)
	f.Add(`<!doctype html><html><head><title>Not a feed</title></head></html>`)
	f.Add(`<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>caf&eacute;</title></item></channel></rss>`)
	f.Add(`<rss><channel><item><title>unterminated`)
	f.Add("")

	f.Fuzz(func(t *testing.T, doc string) {
		// A feed is size-capped at fetch (--max-feed-size); mirror that so runs
		// explore document SHAPES rather than megabyte blobs.
		if len(doc) > 64<<10 {
			t.Skip()
		}
		n := 0
		// `partial` is the parser's own "I streamed some items and then hit
		// malformed bytes" signal; either answer is legal for arbitrary input, so
		// the target judges the items instead.
		_, _, err := ParseFeed([]byte(doc), func(i *mod.RawItem) error {
			if i == nil {
				t.Fatal("ParseFeed streamed a nil item")
			}
			n++
			// Every item is about to be persisted, so the invariants the pack
			// writer assumes must already hold here. A title carrying a NUL
			// would ride into a data pack line and out to every reader.
			if strings.ContainsRune(i.Title, 0) || strings.ContainsRune(i.Link, 0) {
				t.Fatalf("item %d carries a NUL in its title/link", n)
			}
			// A dateless item is legal (nil); a dated one must carry a real
			// instant — the pack writer stamps Published straight from it.
			if i.Published != nil && i.Published.IsZero() {
				t.Fatalf("item %d carries a zero-valued published time", n)
			}
			return nil
		})
		// An error with nothing streamed is the common, correct answer for junk;
		// an error AFTER some items is a truncated feed, and those items were
		// already judged above. Either way there is nothing left to assert —
		// returning normally is the pass.
		_ = err
	})
}
