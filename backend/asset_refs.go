package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"slices"

	"srr/store"
)

// The asset reference sidecar — docs/MANIFEST-SPEC.md §4.7.
//
// WHY IT EXISTS. `assets/` keys are content hashes, so two articles carrying the
// same bytes — a masthead image repeated across a feed's posts, a wire photo two
// feeds both republish — resolve to ONE stored object. Expiration deletes every
// `assets/…` key an expiring article references, and it used to do so with no
// liveness check at all: the FIRST article to age out took the shared object
// with it, and every still-live article referencing it lost its media until an
// operator ran `srr asset heal --create`. Counting references is the fix, and
// the count has to be durable state OF THE STORE — a process-local map would be
// wrong the moment a cycle crashed.
//
// WHAT IT IS. One immutable, write-once object per generation that changed it,
// named by the manifest under `names.aref`, its stem drawn from a per-series
// monotone counter that is never reused, published by the SAME Commit as the
// batch that changed it. That is the seen sidecar's shape exactly, and for the
// same reason: a count that becomes durable separately from the articles it
// counts is wrong in one direction or the other at every crash. It needs no
// ordering proof of its own — §6.1 covers it like everything else.
//
// It rides the `seen` SERIES rather than one of its own because a manifest
// singleton carries its own series (§4.5) and `seen/` is already the
// backend-only, never-reader-fetched directory. Nothing about the pack grammar,
// the generated PACK_SERIES_KINDS or the service worker's routing changes, and
// the GC reaches it through the one rule (delete what the last K manifests do
// not name) with no window formula of its own.
//
// BACKEND-ONLY. The frontend and the service worker never fetch it, exactly like
// `config.gz` and the seen sidecar. Nothing here is part of the writer↔reader
// contract.
//
// COVERAGE — the one thing to understand before touching this file.
//
// A count is only safe to act on when it is COMPLETE: deleting at zero is sound
// exactly when every live article that references the key was counted. Articles
// stored before this sidecar existed were not, so the sidecar states from which
// chron its counts are complete (`from`, in memory `covered`), and expiration
// splits on it:
//
//   - chron >= covered — COVERED. The count governs. A key whose count does not
//     reach zero is KEPT, which is the whole point of this file. A key with NO
//     entry is a count the sidecar should have and does not, i.e. damage: it is
//     KEPT too, and warned about. Failing toward keeping is deliberate — a
//     leaked object costs bytes an operator can reclaim, a wrongly-deleted
//     shared object costs media no article can get back.
//   - chron < covered — UNCOVERED. The sidecar makes no claim about these
//     articles, so the PRE-REFCOUNT RULE stands for them unchanged: the key is
//     deleted with no liveness check, exactly as every release before this one
//     did. This is not "a missing count", it is "no counting was ever done
//     here", and treating it as damage would mean an upgrading store never
//     reclaims another asset byte for its whole pre-upgrade backlog. The
//     uncovered region only shrinks: it drains as those articles expire.
//
// A key that is tracked never takes the uncovered path even when an uncovered
// article references it — the count is better evidence than no evidence, and it
// keeps.
//
// The residual, stated rather than hidden: an uncovered live article and a
// covered one may share a key whose entry counts only the covered one, so the
// covered article's expiry can still delete media the uncovered one shows. That
// is exactly today's behaviour for that pair, it is confined to the draining
// uncovered region, and it is the price of not walking the whole store once at
// upgrade.

const (
	// assetRefsVersion is the sidecar body's own format version. A body this
	// binary cannot read is treated as damage (see loadRefs), never guessed at.
	assetRefsVersion = 1
	// noCoverage is the in-memory `covered` of a sidecar that claims nothing:
	// no article anywhere has had its references counted. A store that has never
	// stored a referencing article since this release sits here, and so does a
	// pre-refcount store on its first open. Never persisted — the first counted
	// reference replaces it with that article's chron.
	noCoverage = -1
)

// assetRefEntry is one key's live reference count plus the feed the object's
// bytes were charged to at upload (Feed.AssetBytes). The owner is recorded when
// the entry is CREATED and is who the bytes are released FROM when the count
// reaches zero — which is what makes `ab` track a feed's own live footprint
// instead of drifting every time a shared asset expires through another feed.
type assetRefEntry struct {
	Refs  int `json:"n"`
	Owner int `json:"o"`
}

// assetRefsDoc is the on-the-wire body: gzipped JSON, deterministic (Go sorts
// map keys), so an unchanged pool re-encodes to identical bytes. JSON rather
// than the seen sidecar's columnar binary because this table is orders of
// magnitude smaller (one row per stored OBJECT, not per remembered GUID) and
// being readable by `zcat | jq` is worth more here than the last 30%.
type assetRefsDoc struct {
	Version int `json:"v"`
	// From is the chron from which the counts are complete. Persisted without
	// omitempty: 0 (a store counted from its very first article) is the most
	// common value and the most load-bearing one.
	From int                      `json:"from"`
	Refs map[string]assetRefEntry `json:"refs,omitempty"`
}

// assetRefs is the in-memory pool. Every method is nil-receiver-safe, like
// seenPool's, so a DB assembled outside NewDB never panics on it.
type assetRefs struct {
	// dirty is set by add/apply when they actually change the table; SyncRefs
	// skips the store write when it is false, so an idle cycle neither writes an
	// object nor mints a generation.
	dirty   bool
	covered int
	m       map[string]assetRefEntry
}

func newAssetRefs() *assetRefs {
	return &assetRefs{covered: noCoverage, m: map[string]assetRefEntry{}}
}

// covers reports whether the article at chron had its asset references counted.
// See the coverage discussion above: false means the pre-refcount rule applies
// to that article, NOT that something is missing.
func (p *assetRefs) covers(chron int) bool {
	return p != nil && p.covered != noCoverage && chron >= p.covered
}

// live reports whether the sidecar still counts a reference to key. Used by the
// paths that delete assets outside expiration's own accounting (compaction), so
// they inherit the same liveness gate instead of re-deriving one.
func (p *assetRefs) live(key string) bool {
	if p == nil {
		return false
	}
	e, ok := p.m[key]
	return ok && e.Refs > 0
}

// add counts every assets/ key the article at chron references, charging a
// newly-tracked key to feedID. Called once per article from PutArticles'
// accounting preamble — the writer's single funnel for stored articles, local
// and inbox-consolidated alike — so the count is established by the same locked
// phase that makes the article durable.
//
// Harvesting is collectAssetRefs, the SAME walk expiration releases through, so
// the two can never disagree about what an article references: identical
// content bytes in, identical key set out, one reference per (article, key) no
// matter how many times the content mentions it.
func (p *assetRefs) add(chron, feedID int, content string) {
	if p == nil {
		return
	}
	keys := map[string]struct{}{}
	collectAssetRefs(content, keys)
	if len(keys) == 0 {
		// An article that references nothing is covered vacuously, so it is not
		// worth claiming coverage (and dirtying the pool) for: the claim starts
		// at the first article that actually contributes a count.
		return
	}
	if p.covered == noCoverage {
		p.covered = chron
	}
	for key := range keys {
		e := p.m[key]
		if e.Refs == 0 {
			e.Owner = feedID
		}
		e.Refs++
		p.m[key] = e
	}
	p.dirty = true
}

// plan decides which harvested keys are provably dead, WITHOUT mutating the
// pool: expiration is all-or-nothing, so the release is applied (apply, below)
// only once every delete has landed.
//
// released counts, per key, how many COVERED expiring articles referenced it;
// uncovered maps a key referenced by an UNCOVERED expiring article to the feed
// that first referenced it in chron order (the pre-refcount AssetBytes
// attribution, preserved verbatim for that region). The returns are the sorted
// delete set, the feed each deleted object's bytes are released from, the number
// of objects kept because a live article still shows them (this file's whole
// reason to exist, so it is worth counting), and the number of covered keys the
// sidecar could not account for — kept too, and warned about by the caller.
func (p *assetRefs) plan(released, uncovered map[string]int) (dead []string, owner map[string]int, kept, unknown int) {
	owner = map[string]int{}
	for key, n := range released {
		e, ok := p.entry(key)
		if !ok {
			// Covered, so a count SHOULD exist. It does not: keep the object.
			unknown++
			continue
		}
		if e.Refs > n {
			kept++
			continue // a live article still shows it
		}
		if e.Refs < n {
			// More releases than references: the table drifted from the packs
			// (a hand-edited sidecar, a partially-applied predecessor). Deleting
			// is still the right call — every referencing article this cycle
			// knows of is expiring — but the drift itself is worth saying.
			slog.Warn("asset refcount drift: more expiring references than counted", "key", key, "counted", e.Refs, "expiring", n)
		}
		owner[key] = e.Owner
	}
	for key, feedID := range uncovered {
		if _, ok := p.entry(key); ok {
			continue // tracked: the count governs, and it was consulted above
		}
		if _, done := owner[key]; done {
			continue
		}
		owner[key] = feedID
	}
	return slices.Sorted(maps.Keys(owner)), owner, kept, unknown
}

// entry reads one key's counts. Split out so plan works on a nil pool (a DB
// assembled outside NewDB) exactly as it works on an empty one.
func (p *assetRefs) entry(key string) (assetRefEntry, bool) {
	if p == nil {
		return assetRefEntry{}, false
	}
	e, ok := p.m[key]
	return e, ok
}

// apply subtracts the planned releases, dropping the entries that reached zero
// — their objects are gone, so remembering them would only grow the sidecar
// forever. Called only after every delete succeeded, so a failed expiration
// leaves the counts exactly where the next cycle's identical walk expects them.
func (p *assetRefs) apply(released map[string]int) {
	if p == nil {
		return
	}
	for key, n := range released {
		e, ok := p.m[key]
		if !ok {
			continue
		}
		e.Refs -= n
		if e.Refs <= 0 {
			delete(p.m, key)
		} else {
			p.m[key] = e
		}
		p.dirty = true
	}
}

func (p *assetRefs) doc() assetRefsDoc {
	return assetRefsDoc{Version: assetRefsVersion, From: p.covered, Refs: p.m}
}

// parseAssetRefs decodes a sidecar body. It is STRICT — an unreadable version,
// a key outside the assets/ grammar, a non-positive count — because the caller's
// answer to "this object is damaged" (keep every asset it cannot prove dead) is
// the safe one, while quietly loading a half-understood table would authorize
// deletes on counts nobody vouched for.
func parseAssetRefs(data []byte) (*assetRefs, error) {
	var doc assetRefsDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	if doc.Version != assetRefsVersion {
		return nil, fmt.Errorf("asset refs: unsupported version %d", doc.Version)
	}
	if doc.From < 0 {
		return nil, fmt.Errorf("asset refs: negative coverage start %d", doc.From)
	}
	p := newAssetRefs()
	p.covered = doc.From
	for key, e := range doc.Refs {
		if !assetKeyRe.MatchString(key) {
			return nil, fmt.Errorf("asset refs: %q is not an assets/ key", key)
		}
		if e.Refs <= 0 {
			return nil, fmt.Errorf("asset refs: %q has a non-positive count %d", key, e.Refs)
		}
		p.m[key] = e
	}
	return p, nil
}

// loadRefs reads the sidecar the manifest names. Three states, and the
// difference between the last two is the whole failure posture:
//
//   - The manifest names none. No counting has ever happened here — a fresh
//     store, or one upgrading from a release without this file. The pool claims
//     NO coverage, so every article predating the first counted reference takes
//     the pre-refcount rule and retention keeps reclaiming exactly as it did.
//   - It names one and it reads. Use it.
//   - It names one and it does not read. The store HAD counts and lost them,
//     which the manifest proves and the object cannot. Claim FULL coverage over
//     an EMPTY table: every key an expiring article references is then a count
//     that should exist and does not, so nothing is deleted — the fail-toward-
//     keeping direction — and a loud WARN says so every cycle. Counting resumes
//     for new articles, so the table refills forward; a post-loss article that
//     re-references a pre-loss asset and expires first can still delete it,
//     which is no worse than the behaviour this file replaced.
//
// Always returns a non-nil pool.
func (o *DB) loadRefs(ctx context.Context) *assetRefs {
	if o.core.Names == nil || o.core.Names.ARef == nil {
		return newAssetRefs()
	}
	key := o.core.Names.arefKey()
	buf, err := o.readGz(ctx, key)
	if err == nil {
		var p *assetRefs
		if p, err = parseAssetRefs(buf); err == nil {
			return p
		}
	}
	slog.Warn("asset refcount sidecar unreadable; expiration will keep every asset it cannot prove dead until the counts rebuild",
		"key", key, "error", err)
	p := newAssetRefs()
	p.covered = 0
	return p
}

// SyncRefs persists the pool under a FRESH stem and records the name, so the
// manifest the caller's Commit publishes points at exactly the reference counts
// that describe this generation's articles. Write-if-dirty: an idle cycle writes
// nothing, leaves the name alone, and therefore mints no generation.
//
// Its failure is FATAL to the cycle (returned, not warned), for the same reason
// SyncSeen's is: a committed batch whose references were not counted leaves
// every one of its keys undercounted, and an undercount is what deletes a shared
// object out from under a live article. The batch is unreferenced garbage until
// the root flips, so aborting costs a cycle and nothing else.
func (o *DB) SyncRefs(ctx context.Context) error {
	if o.refs == nil || !o.refs.dirty {
		return nil
	}
	ref := StemRef{Series: seenSeries, Stem: o.core.Names.alloc(seenSeries)}
	body, err := gzipJSON(o.refs.doc())
	if err != nil {
		return err
	}
	if err := o.AtomicPut(ctx, ref.key(), bytes.NewReader(body), store.ObjectMeta{}); err != nil {
		return err
	}
	o.core.Names.ARef = &ref
	o.refs.dirty = false
	return nil
}
