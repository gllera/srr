package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"srr/store"
)

const (
	refKeyA = "assets/aa/1111111111111111.webp"
	refKeyB = "assets/bb/2222222222222222.webp"
	refKeyC = "assets/cc/3333333333333333.webp"
)

func img(keys ...string) string {
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(`<img src="` + k + `">`)
	}
	return b.String()
}

// refsPoolWith builds a pool covering from chron 0 and counts the given
// (feed, content) articles into it, exactly as PutArticles' preamble would.
func refsPoolWith(articles ...struct {
	feed    int
	content string
}) *assetRefs {
	p := newAssetRefs()
	p.covered = 0
	for i, a := range articles {
		p.add(i, a.feed, a.content)
	}
	return p
}

type refArticle = struct {
	feed    int
	content string
}

// --- the pool's own rules ---------------------------------------------------

func TestAssetRefsAdd(t *testing.T) {
	cases := []struct {
		name      string
		articles  []refArticle
		want      map[string]assetRefEntry
		wantFrom  int
		wantDirty bool
	}{{
		name:      "no references claims no coverage and stays clean",
		articles:  []refArticle{{feed: 7, content: "<p>plain text</p>"}},
		want:      map[string]assetRefEntry{},
		wantFrom:  noCoverage,
		wantDirty: false,
	}, {
		name:      "one article, one key, charged to its feed",
		articles:  []refArticle{{feed: 7, content: img(refKeyA)}},
		want:      map[string]assetRefEntry{refKeyA: {Refs: 1, Owner: 7}},
		wantFrom:  0,
		wantDirty: true,
	}, {
		name: "the same key twice in one article counts once",
		// collectAssetRefs dedups within an article, which is what makes the
		// release symmetric: expiration harvests the same content the same way.
		articles:  []refArticle{{feed: 7, content: img(refKeyA, refKeyA)}},
		want:      map[string]assetRefEntry{refKeyA: {Refs: 1, Owner: 7}},
		wantFrom:  0,
		wantDirty: true,
	}, {
		name: "a shared key counts once per article, owner stays the first",
		articles: []refArticle{
			{feed: 7, content: img(refKeyA)},
			{feed: 9, content: img(refKeyA, refKeyB)},
		},
		want: map[string]assetRefEntry{
			refKeyA: {Refs: 2, Owner: 7},
			refKeyB: {Refs: 1, Owner: 9},
		},
		wantFrom:  0,
		wantDirty: true,
	}, {
		name: "coverage starts at the first REFERENCING article",
		articles: []refArticle{
			{feed: 7, content: "<p>nothing here</p>"},
			{feed: 7, content: "<p>still nothing</p>"},
			{feed: 7, content: img(refKeyA)},
		},
		want:      map[string]assetRefEntry{refKeyA: {Refs: 1, Owner: 7}},
		wantFrom:  2,
		wantDirty: true,
	}, {
		name:      "a key outside the assets/ grammar is never counted",
		articles:  []refArticle{{feed: 7, content: img("assets/../victim")}},
		want:      map[string]assetRefEntry{},
		wantFrom:  noCoverage,
		wantDirty: false,
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newAssetRefs()
			for i, a := range tc.articles {
				p.add(i, a.feed, a.content)
			}
			if p.covered != tc.wantFrom {
				t.Errorf("covered = %d, want %d", p.covered, tc.wantFrom)
			}
			if p.dirty != tc.wantDirty {
				t.Errorf("dirty = %v, want %v", p.dirty, tc.wantDirty)
			}
			if len(p.m) != len(tc.want) {
				t.Fatalf("table = %v, want %v", p.m, tc.want)
			}
			for k, want := range tc.want {
				if got := p.m[k]; got != want {
					t.Errorf("%s = %+v, want %+v", k, got, want)
				}
			}
		})
	}
}

func TestAssetRefsPlan(t *testing.T) {
	cases := []struct {
		name        string
		articles    []refArticle
		released    map[string]int
		uncovered   map[string]int
		wantDead    []string
		wantOwner   map[string]int
		wantKept    int
		wantUnknown int
	}{{
		name:      "the last reference releases the object, to its owner",
		articles:  []refArticle{{feed: 7, content: img(refKeyA)}},
		released:  map[string]int{refKeyA: 1},
		wantDead:  []string{refKeyA},
		wantOwner: map[string]int{refKeyA: 7},
	}, {
		name: "a shared object survives its first expiring referrer",
		articles: []refArticle{
			{feed: 7, content: img(refKeyA)},
			{feed: 9, content: img(refKeyA)},
		},
		released: map[string]int{refKeyA: 1},
		wantDead: nil,
		wantKept: 1,
	}, {
		name: "and dies once every referrer has expired",
		articles: []refArticle{
			{feed: 7, content: img(refKeyA)},
			{feed: 9, content: img(refKeyA)},
		},
		released:  map[string]int{refKeyA: 2},
		wantDead:  []string{refKeyA},
		wantOwner: map[string]int{refKeyA: 7},
	}, {
		name:        "a covered key with no count is KEPT, not guessed at",
		articles:    []refArticle{{feed: 7, content: img(refKeyA)}},
		released:    map[string]int{refKeyB: 1},
		wantDead:    nil,
		wantUnknown: 1,
	}, {
		name:      "an uncovered key nothing tracks takes the pre-refcount rule",
		articles:  []refArticle{{feed: 7, content: img(refKeyA)}},
		uncovered: map[string]int{refKeyC: 3},
		wantDead:  []string{refKeyC},
		wantOwner: map[string]int{refKeyC: 3},
	}, {
		name:      "a TRACKED key an uncovered article references is governed by the count",
		articles:  []refArticle{{feed: 7, content: img(refKeyA)}},
		uncovered: map[string]int{refKeyA: 3},
		wantDead:  nil,
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := refsPoolWith(tc.articles...)
			dead, owner, kept, unknown := p.plan(tc.released, tc.uncovered)
			if !slices.Equal(dead, tc.wantDead) {
				t.Errorf("dead = %v, want %v", dead, tc.wantDead)
			}
			for k, want := range tc.wantOwner {
				if owner[k] != want {
					t.Errorf("owner[%s] = %d, want %d", k, owner[k], want)
				}
			}
			if kept != tc.wantKept {
				t.Errorf("kept = %d, want %d", kept, tc.wantKept)
			}
			if unknown != tc.wantUnknown {
				t.Errorf("unknown = %d, want %d", unknown, tc.wantUnknown)
			}
			// plan decides; it never mutates. Expiration is all-or-nothing, so
			// the counts must still be there for the retry.
			if p.m[refKeyA].Refs == 0 && len(tc.articles) > 0 {
				t.Error("plan mutated the table")
			}
		})
	}
}

func TestAssetRefsApplyDropsAtZero(t *testing.T) {
	p := refsPoolWith(
		refArticle{feed: 7, content: img(refKeyA, refKeyB)},
		refArticle{feed: 9, content: img(refKeyA)},
	)
	p.dirty = false
	p.apply(map[string]int{refKeyA: 1, refKeyB: 1})
	if !p.dirty {
		t.Error("apply left the pool clean")
	}
	if got := p.m[refKeyA]; got.Refs != 1 || got.Owner != 7 {
		t.Errorf("%s = %+v, want one remaining reference owned by 7", refKeyA, got)
	}
	if _, ok := p.m[refKeyB]; ok {
		t.Errorf("%s survived reaching zero; a dead object's entry must go too", refKeyB)
	}
}

func TestAssetRefsRoundTrip(t *testing.T) {
	p := refsPoolWith(
		refArticle{feed: 7, content: img(refKeyA, refKeyB)},
		refArticle{feed: 9, content: img(refKeyA)},
	)
	body, err := gzipJSON(p.doc())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := gunzip(strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseAssetRefs(raw)
	if err != nil {
		t.Fatalf("parseAssetRefs: %v", err)
	}
	if got.covered != p.covered {
		t.Errorf("covered = %d, want %d", got.covered, p.covered)
	}
	for k, want := range p.m {
		if got.m[k] != want {
			t.Errorf("%s = %+v, want %+v", k, got.m[k], want)
		}
	}
}

func TestAssetRefsParseRejects(t *testing.T) {
	cases := []struct{ name, body string }{
		{"not json", "{"},
		{"unknown version", `{"v":99,"from":0}`},
		{"negative coverage", `{"v":1,"from":-1}`},
		{"key outside the assets/ grammar", `{"v":1,"from":0,"refs":{"assets/../victim":{"n":1,"o":0}}}`},
		{"non-positive count", `{"v":1,"from":0,"refs":{"` + refKeyA + `":{"n":0,"o":0}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseAssetRefs([]byte(tc.body)); err == nil {
				t.Fatal("want a parse error: a half-understood table must never authorize deletes")
			}
		})
	}
}

// --- through the real store -------------------------------------------------

// PutArticles is the writer's single funnel for a stored article, so the counts
// must be established there — not in the fan-out that uploaded the bytes.
func TestPutArticlesCountsAssetRefs(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	b := &Feed{Title: "B", URL: "https://b.example/f"}
	for _, f := range []*Feed{a, b} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	putExpireBatch(t, db, fresh1d, []*Item{
		{Feed: a, Title: "a1", Content: img(refKeyA)},
		{Feed: b, Title: "b1", Content: img(refKeyA, refKeyB)},
	})
	if got := db.refs.m[refKeyA]; got.Refs != 2 || got.Owner != a.id {
		t.Errorf("%s = %+v, want 2 references owned by feed %d", refKeyA, got, a.id)
	}
	if got := db.refs.m[refKeyB]; got.Refs != 1 || got.Owner != b.id {
		t.Errorf("%s = %+v, want 1 reference owned by feed %d", refKeyB, got, b.id)
	}
	if db.refs.covered != 0 {
		t.Errorf("covered = %d, want 0 (a store counted from its first article)", db.refs.covered)
	}
}

// THE POINT OF THIS FINDING: two feeds share one content-hash object; the first
// one's article expires and the object must still be there for the second.
func TestExpireKeepsSharedAssetUntilLastReferrer(t *testing.T) {
	db, _, dir := setupTestDB(t)
	old := &Feed{Title: "old", URL: "https://a.example/f", ExpireDays: 10}
	// A second feed with a WIDER window, so its article outlives the first's.
	live := &Feed{Title: "live", URL: "https://b.example/f", ExpireDays: 3650}
	for _, f := range []*Feed{old, live} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	shared := mustWriteAsset(t, dir, refKeyA) // 11 bytes, charged to `old`
	old.AssetBytes = 11
	putExpireBatch(t, db, old20d, []*Item{
		{Feed: old, Title: "o1", Content: img(refKeyA)},
		{Feed: live, Title: "l1", Content: img(refKeyA)},
	})

	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if old.AddIdx != 1 || old.Expired != 1 {
		t.Fatalf("the expiring feed did not expire: AddIdx=%d Expired=%d", old.AddIdx, old.Expired)
	}
	if assetGone(t, shared) {
		t.Fatal("shared asset deleted by its FIRST expiring referrer — the bug FMT2(b) fixes")
	}
	if got := db.refs.m[refKeyA]; got.Refs != 1 {
		t.Fatalf("%s = %+v, want the surviving article's single reference", refKeyA, got)
	}
	// ab is not released while the object is still in the store.
	if old.AssetBytes != 11 {
		t.Fatalf("AssetBytes = %d, want 11 (nothing left the store)", old.AssetBytes)
	}

	// Now age the survivor out too: the last reference releases the object AND
	// its bytes, from the feed that was charged for them at upload.
	live.ExpireDays = 10
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if !assetGone(t, shared) {
		t.Fatal("asset survived its LAST referrer")
	}
	if _, ok := db.refs.m[refKeyA]; ok {
		t.Errorf("%s kept an entry after reaching zero", refKeyA)
	}
	if old.AssetBytes != 0 {
		t.Errorf("AssetBytes = %d, want 0 released from the owner", old.AssetBytes)
	}
	if live.AssetBytes != 0 {
		t.Errorf("the expiring feed was charged %d bytes it never uploaded", live.AssetBytes)
	}
}

// ab exactness: the bytes are released from the feed the sidecar recorded as
// OWNER (the one charged at upload), not from whichever feed happened to expire
// the last article — the skew the pre-refcount accounting documented.
func TestExpireReleasesAssetBytesFromTheOwner(t *testing.T) {
	db, _, dir := setupTestDB(t)
	owner := &Feed{Title: "owner", URL: "https://a.example/f", ExpireDays: 10}
	other := &Feed{Title: "other", URL: "https://b.example/f", ExpireDays: 10}
	for _, f := range []*Feed{owner, other} {
		if err := db.AddFeed(f); err != nil {
			t.Fatal(err)
		}
	}
	mustWriteAsset(t, dir, refKeyA) // 11 bytes
	owner.AssetBytes, other.AssetBytes = 11, 0

	putExpireBatch(t, db, old20d, []*Item{
		{Feed: owner, Title: "o1", Content: img(refKeyA)},
		{Feed: other, Title: "x1", Content: img(refKeyA)},
	})
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if owner.AssetBytes != 0 || other.AssetBytes != 0 {
		t.Fatalf("AssetBytes = owner:%d other:%d, want 0/0 (released once, from the owner)",
			owner.AssetBytes, other.AssetBytes)
	}
}

// The counts and the batch become durable by ONE root flip: SyncRefs writes a
// fresh stem, Commit's manifest names it, and a reopened store reads it back.
func TestSyncRefsIsPublishedWithTheGeneration(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(a); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: a, Title: "a1", Content: img(refKeyA)}})
	if err := db.SyncRefs(ctx); err != nil {
		t.Fatalf("SyncRefs: %v", err)
	}
	first := db.core.Names.ARef
	if first == nil {
		t.Fatal("SyncRefs recorded no name")
	}
	if db.refs.dirty {
		t.Error("SyncRefs left the pool dirty")
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	reopened, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close(ctx)
	if got := reopened.refs.m[refKeyA]; got.Refs != 1 || got.Owner != a.id {
		t.Fatalf("%s = %+v after reopen, want the published count", refKeyA, got)
	}
	if reopened.refs.covered != 0 {
		t.Fatalf("covered = %d after reopen, want 0", reopened.refs.covered)
	}

	// Write-once: a second sync draws a FRESH stem rather than overwriting the
	// object a still-reachable generation names.
	reopened.refs.add(1, a.id, img(refKeyB))
	if err := reopened.SyncRefs(ctx); err != nil {
		t.Fatalf("SyncRefs: %v", err)
	}
	if reopened.core.Names.ARef.Stem == first.Stem {
		t.Fatalf("SyncRefs reused stem %d", first.Stem)
	}
	// Idle: nothing changed, so nothing is written and the name stays put.
	stem := reopened.core.Names.ARef.Stem
	if err := reopened.SyncRefs(ctx); err != nil {
		t.Fatalf("SyncRefs: %v", err)
	}
	if reopened.core.Names.ARef.Stem != stem {
		t.Error("an idle SyncRefs minted a new object")
	}
}

// The other direction of "durable together": a cycle that stored articles but
// never published its counts leaves the root naming the previous generation, so
// the reopened store sees no counts at all — never a half-counted table that
// would under-count a live article's references.
func TestRefsNotPublishedAreNotAdopted(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(a); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: a, Title: "a1", Content: img(refKeyA)}})
	if err := db.Commit(ctx); err != nil { // no SyncRefs: the counts stay in memory
		t.Fatalf("Commit: %v", err)
	}
	reopened, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close(ctx)
	if reopened.core.Names.ARef != nil {
		t.Fatal("an unpublished sidecar was named by the manifest")
	}
	if len(reopened.refs.m) != 0 || reopened.refs.covered != noCoverage {
		t.Fatalf("adopted unpublished counts: %v (covered=%d)", reopened.refs.m, reopened.refs.covered)
	}
}

// putFailBackend refuses every AtomicPut under a key prefix.
type putFailBackend struct {
	store.Backend
	prefix string
}

func (f *putFailBackend) AtomicPut(ctx context.Context, key string, r io.Reader, m store.ObjectMeta) error {
	if strings.HasPrefix(key, f.prefix) {
		return errors.New("injected put failure")
	}
	return f.Backend.AtomicPut(ctx, key, r, m)
}

// SyncRefs is fatal, like SyncSeen: a batch whose counts could not be published
// must not reach the root, or every one of its keys stays undercounted forever.
func TestSyncRefsFailureIsFatal(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(a); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: a, Title: "a1", Content: img(refKeyA)}})
	db.Backend = &putFailBackend{Backend: db.Backend, prefix: seenSeries + "/"}
	if err := db.SyncRefs(ctx); err == nil {
		t.Fatal("want an error: an unwritable refcount sidecar must abort the cycle")
	}
	if db.core.Names.ARef != nil {
		t.Fatal("a failed SyncRefs recorded a name for an object that is not there")
	}
}

// A store that never counted anything (an upgrade from a release without this
// file) claims NO coverage, so retention keeps reclaiming exactly as it did.
// This is deliberately NOT the fail-toward-keeping case: no count is missing,
// none was ever kept.
func TestExpireUncoveredRegionKeepsPreRefcountBehaviour(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	p := mustWriteAsset(t, dir, refKeyA)
	ch.AssetBytes = 11
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1", Content: img(refKeyA)}})

	// Model the pre-refcount store: the article is stored, nothing counted it.
	db.refs = newAssetRefs()
	if err := db.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if !assetGone(t, p) {
		t.Fatal("an uncovered article's asset survived; the pre-refcount rule must still apply there")
	}
	if ch.AssetBytes != 0 {
		t.Errorf("AssetBytes = %d, want 0", ch.AssetBytes)
	}
}

// A sidecar the manifest NAMES but that cannot be read is damage, and damage
// fails toward keeping: a leaked object costs bytes an operator can reclaim, a
// wrongly-deleted shared object costs media no article can get back.
func TestCorruptRefsSidecarKeepsEveryAsset(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	p := mustWriteAsset(t, dir, refKeyA)
	ch.AssetBytes = 11
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1", Content: img(refKeyA)}})
	if err := db.SyncRefs(ctx); err != nil {
		t.Fatalf("SyncRefs: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Corrupt the named object in place, then reopen.
	key := db.core.Names.arefKey()
	if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(key)), []byte("not gzip"), 0o644); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close(ctx)
	if reopened.refs.covered != 0 || len(reopened.refs.m) != 0 {
		t.Fatalf("a corrupt sidecar must claim FULL coverage over an EMPTY table, got covered=%d %v",
			reopened.refs.covered, reopened.refs.m)
	}
	if err := reopened.ExpireArticles(ctx, expNow); err != nil {
		t.Fatalf("ExpireArticles: %v", err)
	}
	if assetGone(t, p) {
		t.Fatal("a corrupt sidecar deleted an asset it could not prove dead")
	}
	live := reopened.core.Feeds[ch.id]
	if live.AddIdx != 1 || live.Expired != 1 {
		t.Fatalf("retention itself stalled: AddIdx=%d Expired=%d", live.AddIdx, live.Expired)
	}
	if live.AssetBytes != 11 {
		t.Errorf("AssetBytes = %d, want 11 (nothing left the store)", live.AssetBytes)
	}
}

// A failed expiration must leave the counts exactly where its own retry expects
// them — all-or-nothing covers the sidecar too.
func TestExpireFailureLeavesRefsUntouched(t *testing.T) {
	db, _, dir := setupTestDB(t)
	ch := &Feed{Title: "A", URL: "https://a.example/f", ExpireDays: 10}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	mustWriteAsset(t, dir, refKeyA)
	putExpireBatch(t, db, old20d, []*Item{{Feed: ch, Title: "o1", Content: img(refKeyA)}})

	db.Backend = &statFailBackend{Backend: db.Backend}
	if err := db.ExpireArticles(ctx, expNow); err == nil {
		t.Fatal("want error from failing Stat")
	}
	if got := db.refs.m[refKeyA]; got.Refs != 1 {
		t.Fatalf("%s = %+v, want its reference intact for the retry", refKeyA, got)
	}
}

// Compaction deletes assets too, so it must go through the same liveness gate —
// it is not a quieter second path around the guarantee.
func TestCompactionSkipsStillReferencedAssets(t *testing.T) {
	db, _, dir := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(a); err != nil {
		t.Fatal(err)
	}
	shared := mustWriteAsset(t, dir, refKeyA)
	orphan := mustWriteAsset(t, dir, refKeyB)
	putExpireBatch(t, db, fresh1d, []*Item{
		{Feed: a, Title: "a1", Content: img(refKeyA)},
	})
	n, err := db.rmAssets(ctx, map[string]struct{}{refKeyA: {}, refKeyB: {}})
	if err != nil {
		t.Fatalf("rmAssets: %v", err)
	}
	if n != 1 {
		t.Fatalf("deleted %d object(s), want 1", n)
	}
	if assetGone(t, shared) {
		t.Error("compaction deleted an object a live article still references")
	}
	if !assetGone(t, orphan) {
		t.Error("compaction kept an object nothing references")
	}
}

// The GC's reachable set is read back through the lenient shim, so the sidecar
// has to survive that round trip — otherwise a generation's counts fall below
// the next window's stem floor and are swept while that generation is still
// restorable.
func TestManifestNamesOfListsTheRefsSidecar(t *testing.T) {
	db, _, _ := setupTestDB(t)
	a := &Feed{Title: "A", URL: "https://a.example/f"}
	if err := db.AddFeed(a); err != nil {
		t.Fatal(err)
	}
	putExpireBatch(t, db, fresh1d, []*Item{{Feed: a, Title: "a1", Content: img(refKeyA)}})
	if err := db.SyncRefs(ctx); err != nil {
		t.Fatalf("SyncRefs: %v", err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	want := db.core.Names.arefKey()
	if !slices.Contains(db.core.Names.keys(), want) {
		t.Fatalf("names.keys() omits %s, so the GC would reclaim a live object", want)
	}
	buf, err := db.readGz(ctx, manifestKey(db.core.ManifestNum))
	if err != nil {
		t.Fatal(err)
	}
	keys, _, err := manifestNamesOf(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(keys, want) {
		t.Fatalf("manifestNamesOf omits %s: %v", want, keys)
	}
}
