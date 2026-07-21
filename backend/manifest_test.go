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
		if err := db.Commit(ctx); err != nil {
			t.Fatalf("commit %d: %v", want, err)
		}
		if core.ManifestNum != want {
			t.Fatalf("after commit %d: m=%d, want %d", want, core.ManifestNum, want)
		}
		man := readManifest(t, dir, want)
		if man.Num != want || man.Version != manifestVersion {
			t.Errorf("manifest %d: got {m:%d v:%d}, want {m:%d v:%d}", want, man.Num, man.Version, want, manifestVersion)
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

// TestManifestNamesRoundTrip pins the §4.5 encoding: RLE'd positional runs plus
// the S32 legacy tail name, expanding back to the exact key list, and a series
// map that survives (Un)MarshalJSON without hard-coding the three series.
func TestManifestNamesRoundTrip(t *testing.T) {
	in := ManifestNames{
		Series: map[string]SeriesNames{
			"idx":  {Runs: [][2]int{{0, 3}}, Tail: "idx/L9.gz"},
			"data": {Base: 1, Runs: [][2]int{{1, 2}}, Tail: "data/L9.gz"},
			// A series the code has never heard of must survive the round trip:
			// ARC6 (merging idx/ and meta/) has to be a manifest-shape change
			// and nothing else (§4.6).
			"future": {Runs: [][2]int{{7, 1}}},
		},
		Deltas: []string{"data/d10.gz", "data/d11.gz"},
		Seen:   "seen.1.gz",
		HSum:   &SummaryName{Key: "idx/h3.gz", Covers: 3},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	// The wire shape is flat: series sit next to the singletons (§12).
	var flat map[string]json.RawMessage
	if err := json.Unmarshal(b, &flat); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"idx", "data", "future", "deltas", "seen", "hsum"} {
		if _, ok := flat[k]; !ok {
			t.Errorf("names is missing key %q: %s", k, b)
		}
	}
	if _, ok := flat["ssum"]; ok {
		t.Errorf("names carries an ssum it was never given: %s", b)
	}

	var out ManifestNames
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.Series["idx"].Keys("idx"); !slices.Equal(got, []string{"idx/0.gz", "idx/1.gz", "idx/2.gz", "idx/L9.gz"}) {
		t.Errorf("idx expansion = %v", got)
	}
	// data is based at 1 — the writer has never produced data/0 — so position 0
	// is empty and the tail lands at position 3 (== NextPackID).
	if got := out.Series["data"].Keys("data"); !slices.Equal(got, []string{"", "data/1.gz", "data/2.gz", "data/L9.gz"}) {
		t.Errorf("data expansion = %v", got)
	}
	if got := out.Series["future"].Keys("future"); !slices.Equal(got, []string{"future/7.gz"}) {
		t.Errorf("unknown series did not survive: %v", got)
	}
	if out.Seen != "seen.1.gz" || out.HSum == nil || out.HSum.Covers != 3 || out.SSum != nil {
		t.Errorf("singletons did not round-trip: %+v", out)
	}
}

// TestManifestNamesRejectsSeriesNameCollision pins the one ambiguity the flat
// encoding could have: a pack series called "deltas"/"seen"/"hsum"/"ssum".
func TestManifestNamesRejectsSeriesNameCollision(t *testing.T) {
	_, err := json.Marshal(ManifestNames{Series: map[string]SeriesNames{"seen": {}}})
	if err == nil {
		t.Fatal("expected an error marshalling a series named after a reserved singleton key")
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

// TestGCManifestsLowWaterDrain pins §7's sweep: it clears (gcm, m−K] and
// advances the low-water only over what it cleared, so nothing is ever
// permanently stranded.
func TestGCManifestsLowWaterDrain(t *testing.T) {
	db, core, dir := setupTestDB(t)
	for range 6 {
		if err := db.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// K=2 ⇒ cutoff 4: manifests 1..4 go, 5 and 6 stay.
	if err := db.GCManifests(ctx, 2); err != nil {
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
	if err := db.GCManifests(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if core.GCManifest != 4 {
		t.Errorf("idle sweep moved gcm to %d", core.GCManifest)
	}
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

// TestManifestAndConfigAreDeletable is the non-negotiable property of S32: the
// two new objects are ADDITIVE. A store stripped of both must still open, read
// and commit through the legacy path exactly as before.
func TestManifestAndConfigAreDeletable(t *testing.T) {
	db, core, dir := setupTestDB(t)
	if err := db.AddFeed(&Feed{Title: "Alpha", URL: "https://a.example/feed", Recipe: "read"}); err != nil {
		t.Fatal(err)
	}
	core.FetchedAt = 1700000000
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	db.Close(ctx)

	if err := os.RemoveAll(filepath.Join(dir, "manifest")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, configFileKey)); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewDB(ctx, false)
	if err != nil {
		t.Fatalf("a store without manifest/ or config.gz must still open: %v", err)
	}
	defer reopened.Close(ctx)
	if reopened.core.FetchedAt != 1700000000 || len(reopened.core.Feeds) != 1 {
		t.Errorf("legacy db.gz did not survive the deletion: %+v", reopened.core)
	}
	if reopened.core.Feeds[0].Recipe != "read" {
		t.Error("configuration is still owned by db.gz in S32 and must survive config.gz deletion")
	}
	if err := reopened.Commit(ctx); err != nil {
		t.Fatalf("commit on a stripped store: %v", err)
	}
}

// TestLegacyDBGzShapeUnchanged is the deployed-reader guarantee, stated as a
// key-set assertion: db.gz still carries exactly the fields it did before the
// DBCore split, plus only the deliberately additive `m`. Anything else here is
// a change a deployed reader could notice.
func TestLegacyDBGzShapeUnchanged(t *testing.T) {
	db, core, dir := setupTestDB(t)
	core.Seq, core.SeenFlag, core.HdrPacks, core.MetaPacks, core.MetaTail = 3, true, 1, 2, 4
	core.NumDeltas, core.DeltaArticles, core.DeltaBytes, core.GCLatestSwept = 1, 5, 6, 7
	core.Gen, core.TotalArticles, core.NextPackID, core.PackOffset, core.FetchedAt = 8, 9, 10, 11, 12
	core.HeadBase, core.Head = 13, []MetaEntry{{FeedID: 0, When: 1}}
	core.DedupDays, core.Inbox = 14, map[string]int64{"p": 15}
	core.Out = []OutFeed{{Name: "n", Format: "rss"}}
	if err := db.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, dbFileKey))
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	body, err := readAllString(gz)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"v", "m", "seq", "sf", "fetched_at", "total_art", "next_pid", "pack_off", "gen",
		"hdrs", "mp", "mt", "nd", "na", "dby", "gcs", "inbox", "recipes", "dd", "feeds",
		"out", "head", "hb",
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("db.gz lost key %q — deployed readers parse it", k)
		}
		delete(got, k)
	}
	for k := range got {
		// gcm is the one other addition, and like m it is omitempty writer state.
		if k != "gcm" {
			t.Errorf("db.gz carries unexpected key %q", k)
		}
	}
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
