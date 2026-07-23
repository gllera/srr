package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func readManifest(t *testing.T, dir string, m int) Manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, manifestKey(m)))
	if err != nil {
		t.Fatalf("read manifest %d: %v", m, err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("manifest %d gzip: %v", m, err)
	}
	var man Manifest
	if err := json.NewDecoder(gz).Decode(&man); err != nil {
		t.Fatalf("manifest %d decode: %v", m, err)
	}
	return man
}

// TestCommitPublishesManifestAndAdvancesCounter pins the core of the commit
// protocol: one immutable manifest per publishing Commit, m advancing by
// exactly 1 (invariant M2), and db.gz naming the one just written.
func TestCommitPublishesManifestAndAdvancesCounter(t *testing.T) {
	db, core, dir := setupTestDB(t)

	for want := 1; want <= 3; want++ {
		// A distinct manifest-state change each cycle so every Commit is a
		// PUBLISHING one — an idle cycle that changed nothing keeps its m (G2).
		core.TotalArticles = want
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("commit %d: %v", want, err)
		}
		if core.ManifestNum != want {
			t.Fatalf("after commit %d: m=%d, want %d", want, core.ManifestNum, want)
		}
		man := readManifest(t, dir, want)
		if man.Num != want || man.Version != dbFormatVersion {
			t.Errorf("manifest %d: got {m:%d v:%d}, want {m:%d v:%d}", want, man.Num, man.Version, want, dbFormatVersion)
		}
	}
}

// TestCommitSkipsIdenticalManifest pins goal G2 (§4.1/§8.1): a cycle that
// changed nothing the manifest describes — only the clock — keeps its
// generation. m stays put, no new manifest object is written, and only the
// ~60-byte root is rewritten with the new t, so every reader's cached manifest
// (and the edge cache in front of it) stays valid. A real change publishes.
func TestCommitSkipsIdenticalManifest(t *testing.T) {
	db, core, dir := setupTestDB(t)
	core.TotalArticles = 5
	core.FetchedAt = 1700000000
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if core.ManifestNum != 1 {
		t.Fatalf("first commit m=%d, want 1", core.ManifestNum)
	}

	// A second cycle that only advances the clock: m must NOT move.
	core.FetchedAt = 1700000300
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if core.ManifestNum != 1 {
		t.Fatalf("idle cycle bumped m to %d; want it to stay 1", core.ManifestNum)
	}
	if _, err := os.Stat(filepath.Join(dir, manifestKey(2))); err == nil {
		t.Fatal("idle cycle wrote manifest/2.gz; want no new generation")
	}
	// The root still resolves at m=1 and carries the fresh t.
	var root RootState
	if err := json.Unmarshal(decompressGz(t, filepath.Join(dir, "db.gz")), &root); err != nil {
		t.Fatal(err)
	}
	if root.ManifestNum != 1 || root.FetchedAt != 1700000300 {
		t.Fatalf("root = {m:%d t:%d}, want {m:1 t:1700000300}", root.ManifestNum, root.FetchedAt)
	}

	// A real manifest-state change publishes again.
	core.TotalArticles = 6
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if core.ManifestNum != 2 {
		t.Fatalf("a real change did not publish: m=%d, want 2", core.ManifestNum)
	}
}

// TestGCNeverSweepsCurrentManifest pins the brick guard: even keep<=0 (the flag
// is floored in main, but GC stays self-safe for any caller) must not delete the
// manifest the root names — a crash before the republishing Commit would
// otherwise leave the store unopenable, with no older manifest to fall back to.
func TestGCNeverSweepsCurrentManifest(t *testing.T) {
	db, core, dir := setupTestDB(t)
	for i := range 4 {
		core.TotalArticles = i + 1
		if err := db.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	for _, keep := range []int{0, -5} {
		if err := db.GC(ctx, keep); err != nil {
			t.Fatalf("GC(keep=%d): %v", keep, err)
		}
		if _, err := os.Stat(filepath.Join(dir, manifestKey(core.ManifestNum))); err != nil {
			t.Fatalf("GC(keep=%d) deleted the current manifest %d: %v (store brick)", keep, core.ManifestNum, err)
		}
	}
}

// TestManifestMirrorsDBCoreState pins that the manifest carries the manifest
// half of db.gz verbatim, and the feed projection — reader-facing fields
// present, config fields absent (docs/MANIFEST-SPEC.md §5).
func TestManifestMirrorsDBCoreState(t *testing.T) {
	db, core, dir := setupTestDB(t)
	if err := db.AddFeed(&Feed{
		Title: "Alpha", URL: "https://a.example/feed", Tag: "news",
		ExpireDays: 30, Recipe: "read", Pipe: []string{"#default"}, DedupDays: 7, DedupTitle: true,
	}); err != nil {
		t.Fatal(err)
	}
	core.FetchedAt = 1700000000
	core.Inbox = map[string]int64{"producer": 42}
	core.DeltaBytes = 999
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	man := readManifest(t, dir, core.ManifestNum)
	if man.FetchedAt != core.FetchedAt {
		t.Errorf("fetched_at: %d, want %d", man.FetchedAt, core.FetchedAt)
	}
	if man.Inbox["producer"] != 42 || man.DeltaBytes != 999 {
		t.Errorf("writer state did not ride the manifest: %+v", man.ManifestWriterState)
	}

	// The feed's public half is published...
	f := man.Feeds[0]
	if f.Title != "Alpha" || f.URL != "https://a.example/feed" || f.Tag != "news" || f.ExpireDays != 30 {
		t.Errorf("feed public fields missing from manifest: %+v", f)
	}
	// ...and its config half is not, anywhere in the bytes.
	raw, err := os.ReadFile(filepath.Join(dir, manifestKey(core.ManifestNum)))
	if err != nil {
		t.Fatal(err)
	}
	gz, _ := gzip.NewReader(bytes.NewReader(raw))
	body, _ := readAllString(gz)
	for _, leaked := range []string{`"recipe"`, `"pipe"`, `"dd"`, `"dt"`, `"ingest"`} {
		if strings.Contains(body, leaked) {
			t.Errorf("manifest leaks backend-only config key %s: %s", leaked, body)
		}
	}
}

// TestManifestNamesRoundTrip pins the §4.5 encoding: RLE'd positional runs of
// OPAQUE stems, an explicit tail position, and a series map that survives
// (Un)MarshalJSON without hard-coding the three series.
func TestManifestNamesRoundTrip(t *testing.T) {
	in := newManifestNames()
	in.Series["idx"] = &SeriesNames{Stems: []int{0, 1, 2, 9}, Tail: 3}
	in.Series["data"] = &SeriesNames{Base: 1, Stems: []int{1, 2, 9}, Tail: 3}
	// A series the code has never heard of must survive the round trip: ARC6
	// (merging idx/ and meta/) has to be a manifest-shape change and nothing
	// else (§4.6).
	in.Series["future"] = &SeriesNames{Stems: []int{7}, Tail: -1}
	in.Deltas = DeltaNames{Series: dataSeries, Stems: []int{10, 11}}
	in.Seen = &StemRef{Series: seenSeries, Stem: 4}
	in.HSum = &SummaryName{Series: idxSeries, Stem: 12, Covers: 3}
	in.Next = map[string]int{"idx": 13, "data": 12, "seen": 5}

	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	// The wire shape is flat: series sit next to the singletons (§12).
	var flat map[string]json.RawMessage
	if err := json.Unmarshal(b, &flat); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"idx", "data", "future", "deltas", "seen", "hsum", "next"} {
		if _, ok := flat[k]; !ok {
			t.Errorf("names is missing key %q: %s", k, b)
		}
	}
	if _, ok := flat["ssum"]; ok {
		t.Errorf("names carries an ssum it was never given: %s", b)
	}
	// Runs, not one integer per object: a pristine store's list is one run.
	if !strings.Contains(string(b), `"r":[[0,3],[9,1]]`) {
		t.Errorf("idx stems were not run-length encoded: %s", b)
	}

	var out ManifestNames
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	keys := func(series string) []string {
		s := out.Series[series]
		got := make([]string, 0, len(s.Stems))
		for i := range s.Stems {
			k, err := out.key(series, s.Base+i)
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, k)
		}
		return got
	}
	if got := keys("idx"); !slices.Equal(got, []string{"idx/0.gz", "idx/1.gz", "idx/2.gz", "idx/9.gz"}) {
		t.Errorf("idx expansion = %v", got)
	}
	// data is based at 1 — the writer has never produced position 0 — so the
	// tail lands at position 3 (== NextPackID).
	if got := keys("data"); !slices.Equal(got, []string{"data/1.gz", "data/2.gz", "data/9.gz"}) {
		t.Errorf("data expansion = %v", got)
	}
	if out.tailKey("data") != "data/9.gz" {
		t.Errorf("data tail = %q", out.tailKey("data"))
	}
	if got := keys("future"); !slices.Equal(got, []string{"future/7.gz"}) {
		t.Errorf("unknown series did not survive: %v", got)
	}
	if out.Seen == nil || out.Seen.key() != "seen/4.gz" || out.HSum == nil || out.HSum.Covers != 3 || out.SSum != nil {
		t.Errorf("singletons did not round-trip: %+v", out)
	}
	if out.Next["idx"] != 13 {
		t.Errorf("stem counters did not round-trip: %v", out.Next)
	}
}

// TestManifestNamesRejectsSeriesNameCollision pins the one ambiguity the flat
// encoding could have: a pack series called "deltas"/"seen"/"hsum"/"ssum"/"next".
func TestManifestNamesRejectsSeriesNameCollision(t *testing.T) {
	n := newManifestNames()
	n.Series["seen"] = &SeriesNames{}
	if _, err := json.Marshal(n); err == nil {
		t.Fatal("expected an error marshalling a series named after a reserved singleton key")
	}
}

// TestManifestNamesRefusesHoles pins M5: positional density from the base is
// what lets floor(chron/stride) index the list, so a gap must be refused rather
// than silently listed.
func TestManifestNamesRefusesHoles(t *testing.T) {
	n := newManifestNames()
	if err := n.putAt(idxSeries, 0, n.alloc(idxSeries)); err != nil {
		t.Fatal(err)
	}
	if err := n.putAt(idxSeries, 2, n.alloc(idxSeries)); err == nil {
		t.Fatal("a hole at position 1 must be refused")
	}
	if _, err := n.key(idxSeries, 5); err == nil {
		t.Fatal("an unlisted position must fail loudly, not fabricate a name")
	}
}

// TestPublishManifestRejectsRacingWriter is the §6.2 poor-man's CAS: a second
// writer that raced past the advisory lock must fail on the name it has to
// publish, BEFORE it can flip the root.
func TestPublishManifestRejectsRacingWriter(t *testing.T) {
	db, core, _ := setupTestDB(t)
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// A peer writer publishes generation 2 AND flips the root to it, while this
	// handle still believes the store is at generation 1.
	peer, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	peer.core.TotalArticles = 99 // a real change, so the peer actually publishes generation 2
	if err := peer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	peer.Close(ctx)

	err = db.publishManifest(ctx)
	if err == nil {
		t.Fatal("expected the racing publish to fail loudly")
	}
	if !strings.Contains(err.Error(), "another writer") {
		t.Errorf("error %q does not name the race", err)
	}
	if core.ManifestNum != 1 {
		t.Errorf("counter advanced despite the failed publish: m=%d", core.ManifestNum)
	}
}

// TestPublishManifestOverwritesOrphan is the deliberate exception to that rule
// (§6.2): a crash between publishing a manifest and flipping the root leaves
// that name taken on an object nothing references. The retry must classify it
// by RE-READING the root and overwrite it, not abort forever.
func TestPublishManifestOverwritesOrphan(t *testing.T) {
	db, core, dir := setupTestDB(t)
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Simulate the crash: manifest 2 is on disk, the root still says 1.
	orphan := filepath.Join(dir, manifestKey(2))
	if err := os.WriteFile(orphan, []byte("garbage from a crashed cycle"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := db.publishManifest(ctx); err != nil {
		t.Fatalf("retry after a crash must overwrite the unreferenced orphan: %v", err)
	}
	if core.ManifestNum != 2 {
		t.Fatalf("m=%d, want 2", core.ManifestNum)
	}
	if man := readManifest(t, dir, 2); man.Num != 2 {
		t.Errorf("orphan was not replaced: %+v", man)
	}
}

// TestGCLowWaterDrain pins §7's ONE rule: delete what the last K manifests do
// not name, as a low-water drain that advances only over what it cleared, so
// nothing is ever permanently stranded.
func TestGCLowWaterDrain(t *testing.T) {
	db, core, dir := setupTestDB(t)
	for i := range 6 {
		core.TotalArticles = i + 1 // distinct state each cycle so each Commit publishes
		if err := db.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// K=2 => cutoff 4: manifests 1..4 go, 5 and 6 stay.
	if err := db.GC(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if core.GCManifest != 4 {
		t.Errorf("gcm=%d, want 4", core.GCManifest)
	}
	for g := 1; g <= 6; g++ {
		_, err := os.Stat(filepath.Join(dir, manifestKey(g)))
		if want := g > 4; (err == nil) != want {
			t.Errorf("manifest %d present=%v, want %v", g, err == nil, want)
		}
	}
	// A second run with nothing new to do must not move the low-water.
	if err := db.GC(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if core.GCManifest != 4 {
		t.Errorf("idle sweep moved gcm to %d", core.GCManifest)
	}
}

// TestGCReclaimsSupersededObjects is the other half of the one rule: an object
// a superseded generation named and the window no longer does is deleted, and
// one the window still names survives. Under opaque stems that is decidable by
// name alone — no window arithmetic, no per-series formula.
func TestGCReclaimsSupersededObjects(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{Title: "feed", URL: "https://example.com/f"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putOneArticle(t, db, ch, 1)
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	superseded := tailK(c, idxSeries)

	putOneArticle(t, db, ch, 2)
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	live := tailK(c, idxSeries)
	if live == superseded {
		t.Fatal("the tail name was reused — stems must never repeat")
	}
	assertKey(t, dir, superseded, true) // still inside the grace window

	if err := db.GC(ctx, 0); err != nil { // K=0: only the current generation is reachable
		t.Fatalf("GC: %v", err)
	}
	assertKey(t, dir, superseded, false)
	assertKey(t, dir, live, true)
}

// TestConfigSidecarWrittenOnConfigChangeOnly pins the write gate: config.gz is
// bootstrapped on the first commit and then rewritten ONLY when configuration
// actually changed — an ordinary fetch cycle must not touch it.
func TestConfigSidecarWrittenOnConfigChangeOnly(t *testing.T) {
	db, core, dir := setupTestDB(t)
	path := filepath.Join(dir, configFileKey)

	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("config.gz was not bootstrapped on the first commit: %v", err)
	}

	// A non-config commit (a fetch cycle's shape: counters move, config does not).
	core.TotalArticles = 7
	core.FetchedAt = 1700000000
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Error("a non-config commit rewrote config.gz")
	}

	// A config mutation must land.
	core.Recipes["read"] = Recipe{Pipe: []string{"#readability", "#default"}}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfigSidecar(func(key string) ([]byte, error) {
		raw, err := os.ReadFile(filepath.Join(dir, key))
		if err != nil {
			return nil, err
		}
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		s, err := readAllString(gz)
		return []byte(s), err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got.Recipes["read"]; !ok {
		t.Errorf("config mutation did not reach config.gz: %+v", got)
	}
}

// TestConfigSidecarSelfHealsWhenDeleted pins the rollback story: deleting
// config.gz (like deleting every manifest) is safe, and the next commit
// republishes it rather than leaving the store without one forever.
func TestConfigSidecarSelfHealsWhenDeleted(t *testing.T) {
	db, _, dir := setupTestDB(t)
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, configFileKey)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	fresh, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close(ctx)
	if err := fresh.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("config.gz did not self-heal: %v", err)
	}
}

// TestMigrationFromLegacyRoot is the one-way door, exercised: a store written
// under the pre-cutover root must open, migrate on the first LOCKED session,
// and come out the other side addressable purely through listed names — with
// the retired db/ snapshots and seen ping/pong slots reaped.
func TestMigrationFromLegacyRoot(t *testing.T) {
	db, c, dir := setupTestDB(t)
	ch := &Feed{Title: "Alpha", URL: "https://a.example/feed", Recipe: "read"}
	if err := db.AddFeed(ch); err != nil {
		t.Fatal(err)
	}
	putOneArticle(t, db, ch, 1)
	putOneArticle(t, db, ch, 2)
	if err := db.SyncMeta(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	total, tail := c.TotalArticles, tailK(c, idxSeries)
	db.Close(ctx)

	// Rewrite the store into the pre-cutover shape: a v1 root carrying every
	// legacy field, with the tail packs under their L<gen> names.
	writeLegacyStore(t, dir, total)

	// A READ-ONLY session must resolve the derived names in memory and publish
	// nothing.
	ro, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("read-only open of a pre-cutover store: %v", err)
	}
	if ro.core.legacyRoot == nil {
		t.Error("read-only open did not classify the store as pre-cutover")
	}
	if ro.core.TotalArticles != total {
		t.Errorf("total_art = %d, want %d", ro.core.TotalArticles, total)
	}
	if got := tailK(&ro.core, idxSeries); got != "idx/L1.gz" {
		t.Errorf("derived idx tail = %q, want the legacy name", got)
	}
	ro.Close(ctx)

	// The first LOCKED session migrates.
	mig, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("locked open of a pre-cutover store: %v", err)
	}
	if mig.core.legacyRoot != nil {
		t.Error("the locked open did not migrate")
	}
	if err := mig.Commit(ctx); err != nil {
		t.Fatalf("commit after migration: %v", err)
	}
	mig.Close(ctx)

	raw := string(decompressGz(t, filepath.Join(dir, dbFileKey)))
	if !strings.HasPrefix(raw, `{"v":3,"m":`) {
		t.Errorf("root was not flipped to v2: %s", raw)
	}
	for _, gone := range []string{"db/1.gz", "seen.0.gz", "seen.1.gz"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); err == nil {
			t.Errorf("%s survived the migration", gone)
		}
	}

	// And the migrated store reads back through listed names only.
	final, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("reopen after migration: %v", err)
	}
	defer final.Close(ctx)
	if final.core.TotalArticles != total {
		t.Errorf("total_art after migration = %d, want %d", final.core.TotalArticles, total)
	}
	if final.core.Feeds[0].Recipe != "read" {
		t.Error("the config sidecar did not adopt the legacy per-feed configuration")
	}
	newTail := tailK(&final.core, idxSeries)
	if newTail == tail || strings.Contains(newTail, "/L") {
		t.Errorf("idx tail = %q: the migration must republish it under an opaque stem", newTail)
	}
	if _, err := os.Stat(filepath.Join(dir, newTail)); err != nil {
		t.Errorf("migrated idx tail %s is missing: %v", newTail, err)
	}
	fetch := func(key string) ([]byte, error) { return final.readGz(ctx, key) }
	if issues := (&InspectCmd{}).checkManifest(fetch, &final.core); issues != 0 {
		t.Errorf("migrated store: checkManifest reported %d issue(s)", issues)
	}
}

// writeLegacyStore rewrites an already-built v2 store into the pre-cutover
// shape: a v1 db.gz carrying every retired field, the tail packs renamed to
// their L<gen> spellings, a db/ snapshot, and a seen ping/pong slot.
func writeLegacyStore(t *testing.T, dir string, total int) {
	t.Helper()
	db, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	c := &db.core
	l := legacyCore{
		Version:       1,
		FetchedAt:     c.FetchedAt,
		TotalArticles: c.TotalArticles,
		MetaTail:      c.MetaTail,
		Head:          c.Head,
		HeadBase:      c.HeadBase,
		Recipes:       c.Recipes,
		DedupDays:     c.DedupDays,
		Out:           c.Out,
		PackOffset:    c.PackOffset,
		NextPackID:    c.NextPackID,
		Seq:           1,
		MetaPacks:     c.metaPacks(),
		Feeds:         c.Feeds,
	}
	renames := [][2]string{
		{tailK(c, idxSeries), "idx/L1.gz"},
		{tailK(c, dataSeries), "data/L1.gz"},
	}
	if k := tailK(c, metaSeries); k != "" {
		renames = append(renames, [2]string{k, "meta/L1.gz"})
	}
	if c.Names.Seen != nil {
		renames = append(renames, [2]string{c.Names.Seen.key(), "seen.0.gz"})
	}
	db.Close(ctx)

	for _, r := range renames {
		if err := os.Rename(filepath.Join(dir, r[0]), filepath.Join(dir, r[1])); err != nil {
			t.Fatalf("rename %s -> %s: %v", r[0], r[1], err)
		}
	}
	if err := os.RemoveAll(filepath.Join(dir, "manifest")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, configFileKey)); err != nil {
		t.Fatal(err)
	}
	// A db/ snapshot the cutover must reap by name (§10.1).
	if err := os.MkdirAll(filepath.Join(dir, "db"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "db/1.gz"), []byte("stale snapshot"), 0o644); err != nil {
		t.Fatal(err)
	}
	body, err := gzipJSON(l)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, dbFileKey), body, 0o644); err != nil {
		t.Fatal(err)
	}
	_ = total
}

func readAllString(r interface{ Read([]byte) (int, error) }) (string, error) {
	var b bytes.Buffer
	if _, err := b.ReadFrom(readerFunc(r.Read)); err != nil {
		return "", err
	}
	return b.String(), nil
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

var _ = context.Background

// TestStaleConfigEntrySweptBeforeIDReuse pins the §6.4 fix: a config.gz entry
// for a feed the manifest no longer has (what a removal's lost post-flip config
// write leaves behind) is swept on the next commit, so reusing that id can NOT
// silently apply the removed feed's recipe/pipe/dedup to the new feed.
func TestStaleConfigEntrySweptBeforeIDReuse(t *testing.T) {
	db, core, dir := setupTestDB(t)
	core.Recipes["x"] = Recipe{Pipe: []string{"#minify"}}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	db.Close(ctx)

	// Simulate the crash: config.gz names feed 0 (recipe "x") though the manifest
	// (an empty store) never had it.
	stale := configSidecar{
		Version: dbFormatVersion,
		StoreConfig: StoreConfig{Recipes: map[string]Recipe{
			defaultRecipeName: {Pipe: defaultRootPipe()},
			"x":               {Pipe: []string{"#minify"}},
		}},
		Feeds: map[int]FeedConfig{0: {Recipe: "x"}},
	}
	body, err := gzipJSON(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, configFileKey), body, 0o644); err != nil {
		t.Fatal(err)
	}

	// Reuse id 0 with an all-default feed and commit.
	db2, err := NewDB(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := db2.AddFeed(&Feed{Title: "New", URL: "https://new.example/feed"}); err != nil {
		t.Fatal(err)
	}
	if db2.core.Feeds[0] == nil {
		t.Fatal("AddFeed did not take id 0")
	}
	if err := db2.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	db2.Close(ctx)

	// Reopen: the stale recipe must be gone — the new feed 0 keeps its default.
	db3, err := NewDB(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db3.Close(ctx)
	if got := db3.core.Feeds[0].Recipe; got != "" {
		t.Fatalf("feed 0 inherited the removed feed's recipe %q; the stale config.gz entry was not swept", got)
	}
}
