package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"time"

	"srr/store"
)

// Format atoms of the writer↔reader data contract. These are the single
// source of truth: `srr gen-ts` (cmd_gents.go) emits them to
// frontend/src/js/format.gen.ts for the frontend reader.
const (
	dbFileKey = "db.gz"
	dbLockKey = ".locked"
	// dbFormatVersion is the store format version this binary writes and can
	// read: the `v` of the root db.gz AND of every manifest it names (they are
	// one format — a root is a pointer into the manifest chain and neither is
	// meaningful without the other, which is why there is one constant and not
	// two). Commit stamps it; NewDB REFUSES a store whose stored version is
	// higher, because forward compatibility is not achievable by omitempty
	// fallback alone: an older binary silently drops every field it does not
	// know on its next Commit, which is data loss that looks like success.
	//
	// v3 is the generation-manifest model (docs/MANIFEST-SPEC.md): the root
	// shrank to {v, m, t}, object names are listed rather than derived, and the
	// operator's configuration moved to config.gz. A v1 store is READ (so the
	// tools work on one that no locked session has touched yet) and MIGRATED by
	// the first locked session — see root.go.
	//
	// ⚠ THREE, not the two the spec's §4.1 example prints, and the reason is the
	// one thing about this cutover worth remembering. The dual-write release
	// (S32/S33) shipped manifests stamped `v:2` whose `names` used a
	// TRANSITIONAL encoding — kind-lettered tail strings, a string array of
	// delta keys, `hsum.key`. The cutover replaced that encoding with opaque
	// stems. A reader from that release parses a v2 root happily and then reads
	// the new `names` as "no delta segments, no tails, no summaries", which on
	// any store with a live delta chain is a hard error with an internal
	// message — NOT the clean version-reject the rollout plan is built on.
	// Stamping 3 makes that reader stop at the ROOT, before it fetches anything,
	// with "This reader is older than the store — reload to update." A version
	// number that says "the bytes changed incompatibly" is the whole point of
	// having one; two incompatible changes need two numbers.
	dbFormatVersion = 3
	// idxPackSize is the idx split threshold: entries per finalized pack.
	idxPackSize = 50000
	// metaPackSize is the meta/ split threshold: entries per finalized meta
	// shard. A divisor of idxPackSize (50000/5000 = 10) so a meta shard never
	// straddles an idx-pack boundary, keeping the meta↔idx mapping clean for
	// the writer and `srr inspect`.
	metaPackSize = 5000
	// feedIDCeiling is the feed-id ceiling: feed_id is a uint16 in each idx
	// entry, so ids run [0, feedIDCeiling).
	feedIDCeiling = 65536
	// headMax caps the newest-glance head projection carried inside db.gz
	// (DBCore.Head): the newest headMax meta cards ride the one object the
	// reader fetches no-cache on every load, so the home list's newest window
	// renders with zero meta-pack fetches. Sized to cover the list's first
	// page (BATCH=30) with headroom while adding ~1-2KB to db.gz.
	headMax = 40
	// idxStateSize is the 2 leading uint32 LE idx-header state fields
	// (packId/packOff bases).
	idxStateSize = 2 * 4
	// idxHeaderPrefix is the fixed idx-header prefix: the 2 state uint32s plus
	// the numSlots uint32. The variable cumulative-count array (numSlots × u32)
	// follows it.
	idxHeaderPrefix = idxStateSize + 4
	// idxEntrySize is the per-entry idx byte width: feed_id:u16 LE.
	idxEntrySize = 2
	// idxBoundarySize is the idx footer element width: each data-pack boundary
	// is a u16 LE local entry index at which the data packId advances by 1.
	idxBoundarySize = 2
	// searchGram is the rune length of the sliding windows ("trigrams") the
	// search blooms index, taken over each word of a folded title.
	searchGram = 3
	// searchBloomBytes is the fixed-size trigram Bloom filter prefixed inside
	// every finalized meta shard and concatenated into meta/s<N>.gz. 4096 bytes
	// = 2^15 bits — a power of two so probe indices mask instead of modulo,
	// sized for a 5,000-title shard.
	searchBloomBytes = 4096
	// searchBloomK is the number of bloom bits set/tested per gram. 7 is the
	// near-optimal probe count for ~3,500 trigrams in 2^15 bits ((m/n)·ln2 ≈
	// 6.5); it minimizes the per-(shard,gram) false-positive rate (~1.1%).
	searchBloomK = 7
	// maxDeltasDefault is the --max-deltas default: how many delta segments
	// (data/d<g>.gz, one per article-producing cycle) may accumulate before a
	// cycle consolidates them into the tail packs (~1h at a 5-min loop).
	// Exported to TS as MAX_DELTAS (a contract atom, like LATEST_KEEP).
	// 0 (the kill switch) consolidates every cycle: the pre-delta behavior.
	maxDeltasDefault = 12
	// maxDeltaBytesDefault is the --max-delta-bytes default in KB: consolidate
	// once the live deltas exceed this much uncompressed article JSONL, so a
	// cold reader's delta payload stays bounded even under huge batches.
	maxDeltaBytesDefault = 256
)

// defaultRootPipe returns a fresh copy of the pipeline seeded into the
// reserved `default` recipe when a loaded db.gz has none. Returning a fresh
// slice each call keeps callers from mutating shared state.
func defaultRootPipe() []string {
	return []string{"#sanitize", "#minify"}
}

// defaultRecipeName is the reserved recipe every feed falls back to and the
// new home for what the old root pipe/ingest expressed. It always exists
// (NewDB seeds it); its pipe must not contain the #default composition token
// (enforced by the CLI: `recipe set default` rejects `#default`).
const defaultRecipeName = "default"

// Recipe is a named {ingest, pipe} bundle referenced by feeds (Feed.Recipe).
// An empty field means "inherit the default recipe's value for that axis":
// each axis falls back independently (see recipeFor + Feed.Fetch).
type Recipe struct {
	Ingest string   `json:"ingest,omitempty"`
	Pipe   []string `json:"pipe,omitempty"`
}

// recipeFor resolves a recipe name against the map. An empty or unknown name
// returns the default recipe — lenient, so a dangling reference (hand-edited
// db.gz) never crashes a fetch; the CLI prevents creating dangling refs. A
// plain map (not *DB) so the fetch path can resolve from fetchRun without
// threading the whole DB through Feed.Fetch.
func recipeFor(recipes map[string]Recipe, name string) Recipe {
	if name != "" {
		if r, ok := recipes[name]; ok {
			return r
		}
	}
	return recipes[defaultRecipeName]
}

func jsonEncode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// gunzip decompresses a gzip stream into a single byte slice.
func gunzip(r io.Reader) ([]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	return io.ReadAll(gz)
}

type DB struct {
	store.Backend
	core DBCore
	// seen is the persistent dedup pool, loaded by NewDB from the seen object
	// the manifest names (empty when absent/corrupt) and written by SyncSeen
	// under a fresh stem. Backend-only; the reader never sees it. Always
	// non-nil after NewDB.
	seen *seenPool
	// legacyReap holds the pre-cutover objects migrateRoot superseded and that
	// no manifest will ever name (the db/ snapshot series, the retired seen
	// ping/pong slots). Removed after the root flip, warn-only — see reapLegacy.
	legacyReap []string
	// configAtOpen is the config-sidecar projection of the db.gz this handle
	// loaded. Commit compares against it to decide whether this session changed
	// configuration, so config.gz is rewritten only on a real config mutation
	// and at no extra store round-trip. nil for a store that has never
	// published a manifest, which is what bootstraps the sidecar on the first
	// S32 commit.
	configAtOpen *configSnapshot
	// configConfirmed records that this handle has established config.gz is
	// actually present (it wrote one, or a Stat found one), so the presence
	// probe in configChanged runs at most once per handle.
	configConfirmed bool
	locked          bool
	// consolidated is the full replay slice (parsed deltas ++ this cycle's
	// batch) when PutArticles consolidated the tail this cycle, else nil
	// (cleared at every PutArticles entry). SyncMeta's fast path consumes it so
	// a consolidation cycle builds its meta entries from memory instead of
	// re-reading the packs just written; prevMetaTail is the meta tail key the
	// consolidation superseded — SyncMeta's read-back candidate for the
	// previous meta tail.
	consolidated []ArticleData
	prevMetaTail string
	// deltaMemo caches the parsed live delta chain (plus each entry's verbatim
	// JSONL line bytes) for the duration of one cycle, keyed on (Seq, NumDeltas)
	// — the write-once delta names make that pair pin the chain content exactly,
	// and the key changes the instant emitDelta/consolidateTail mutate the
	// chain, so a stale entry is never served. One fetch+parse per cycle then
	// feeds every seam-crossing walkArticles (ExpireArticles/SyncOutFeeds/
	// SyncMeta) plus consolidateTail/DrainDeltas, instead of each re-fetching the
	// whole chain from the store. nil until first load. See loadDeltaChain.
	deltaMemo    *deltaChain
	deltaMemoKey [2]int
}

// deltaChain is the parsed live delta chain plus each entry's verbatim JSONL
// line bytes (as read off the segment, so consolidation replays pre-encoded
// data-pack bytes instead of re-encoding every ArticleData — jsonEncode is
// deterministic, so the bytes are identical). Arts and Lines are parallel.
type deltaChain struct {
	Arts  []ArticleData
	Lines [][]byte
}

// DBCore is the store's in-memory state. It is NOT a wire type: nothing
// serializes it. The generation-manifest model (docs/MANIFEST-SPEC.md §5.1)
// splits what used to be one db.gz object across three published objects, and
// DBCore is assembled by EMBEDDING exactly those groups so a field cannot drift
// from the object that carries it:
//
//   - Version / ManifestNum → the root db.gz (§4.1), the ~60-byte pointer.
//   - ManifestState         → the immutable manifest body (§4.2).
//   - ManifestWriterState   → writer-private state, also on the manifest (§4.4).
//   - Names                 → the manifest's explicit object-name table (§4.5).
//   - StoreConfig           → the backend-only config.gz sidecar (§4.3).
//
// Feeds hangs off DBCore rather than off a group because a feed itself splits
// (§5.2): its reader-facing half projects to the manifest (feedPublicOf) and
// its config half to the sidecar (feedConfigOf).
type DBCore struct {
	// Version is the store format version this state was loaded at
	// (dbFormatVersion once Commit has stamped it).
	Version int
	// ManifestNum names the current generation manifest, manifest/<m>.gz.
	ManifestNum int
	ManifestState
	StoreConfig
	ManifestWriterState
	// Names is the explicit object-name table (names.go): the reason `seq`,
	// `nd`, `hdrs`, `mp` and `gen` no longer exist.
	Names *ManifestNames
	Feeds map[int]*Feed

	// legacyRoot / legacyKeys are set only while a pre-cutover store is open
	// and the first locked session has not migrated it yet (root.go).
	legacyRoot *legacyCore
	legacyKeys []legacyObject
}

// ManifestState is the reader-visible half of the committed state: exactly what
// the immutable manifest publishes besides the object names (§4.2). Manifest
// embeds this same struct, so a field added here lands in the manifest without
// anyone remembering to copy it.
type ManifestState struct {
	FetchedAt     int64 `json:"fetched_at"`
	TotalArticles int   `json:"total_art"`
	// MetaTail is the entry count of the published latest meta shard (the meta
	// series' tail object the name table lists). SyncMeta trusts a read-back
	// tail only when its count matches, so a stale shard from a crash is rebuilt
	// from data packs instead of extended.
	MetaTail int `json:"mt,omitempty"`
	// DeltaArticles is the total article count across the live deltas.
	// tailCovered = TotalArticles − DeltaArticles is the seam: chrons below it
	// are served by packs, chrons at/above it by the resident delta articles.
	// Deliberately redundant with the parsed chain's line count — loadDeltas
	// cross-validates and fails loudly on drift. omitempty.
	DeltaArticles int `json:"na,omitempty"`
	// Head is the newest-glance projection: the newest min(headMax, MetaTail)
	// meta cards, in chron order — Head[i] is the card at chron HeadBase+i.
	// Maintained by SyncMeta from the tail lines it just wrote (never a
	// separate store read). The reader's loadMeta serves that chron window
	// straight from it (db.gz is fetched no-cache every load), skipping the
	// ~200KB generation-named meta tail no edge cache can hold. Right after a
	// shard finalization the tail — and so Head — can run shorter than
	// headMax; the reader falls back to meta/data packs outside the window.
	// omitempty; absent (old writer) simply disables the fast path.
	Head []MetaEntry `json:"head,omitempty"`
	// HeadBase is the chron of Head[0], written by the same successful
	// SyncMeta. The base is explicit — NOT derived from TotalArticles by the
	// reader — because SyncMeta is warn-only: a failed sync commits a db.gz
	// with a grown TotalArticles and the previous cycle's Head, and a derived
	// base would misaddress every card by the batch size. Anchored to its own
	// base, a stale Head still serves correct (immutable) cards for its own
	// range while the new chrons fall through to the meta/data path.
	// omitempty; 0 is the natural base for a store under headMax articles.
	HeadBase int `json:"hb,omitempty"`
}

// StoreConfig is the store-wide operator configuration: everything that moves
// out of the reader-hot object into the backend-only config.gz sidecar (§4.3,
// §5.1). configSidecar embeds this struct, so the sidecar carries exactly this
// field set with these tags.
type StoreConfig struct {
	// Recipes is the map of named {ingest, pipe} bundles feeds reference by
	// name (Feed.Recipe). Always contains the reserved "default" entry (seeded
	// by NewDB). Backend-only config: the frontend/service-worker ignores it,
	// like Out. omitempty is harmless — NewDB re-seeds an absent map.
	Recipes map[string]Recipe `json:"recipes,omitempty"`
	// DedupDays is the store-wide default seen.gz horizon in days, the fallback
	// for a feed whose own Feed.DedupDays is 0. Absent/0 ⇒ defaultDedupDays (30).
	// A negative store default is invalid config (there is no store-wide off
	// switch — a per-feed -1 is that lever); (*Feed).dedupDays treats <= 0 as
	// unset. Backend-only, like Recipes/Out — the frontend/service-worker ignore
	// it. omitempty; managed via `srr dedup --days N`.
	DedupDays int `json:"dd,omitempty"`
	// Out is the list of named syndication output feeds written by SyncOutFeeds
	// during each fetch cycle. Each OutFeed maps chosen tags/feed ids to one
	// RSS 2.0 or JSON Feed 1.1 file at out/<name>.<ext> on the CDN. Off by
	// default (nil → SyncOutFeeds no-op). Managed by `srr syndicate`.
	// NOTE: out/* objects are the ONE documented mutable class besides db.gz;
	// the frontend/service-worker ignores the `out` field entirely (backend-only
	// config and output key space).
	Out []OutFeed `json:"out,omitempty"`
}

// ManifestWriterState is the writer-private bookkeeping that rides the manifest
// (§4.4): one object describes one store state, completely. Manifest embeds it,
// so these fields reach the manifest by construction.
type ManifestWriterState struct {
	PackOffset int `json:"pack_off"`
	// NextPackID is the POSITION the data series' tail occupies — the value
	// every idx header's packId_base and every idx footer boundary is stated
	// in, and the writer's cursor while a consolidation rolls data packs. It is
	// deliberately kept even though the name list also implies it (the tail's
	// position), for the same reason `na` and `mt` are kept: it is redundant
	// state that `srr inspect --validate` cross-checks (M5), and a positional
	// cursor is not a name — nothing derives a key from it.
	NextPackID int `json:"next_pid"`
	// DeltaBytes is writer-only trigger state: cumulative uncompressed JSONL
	// bytes across the live deltas (reset at consolidation), driving the
	// --max-delta-bytes consolidation trigger without re-reading the chain. On
	// the wire like Recipes/Out but ignored by the frontend/service-worker.
	DeltaBytes int64 `json:"dby,omitempty"`
	// GCManifest is the manifest-GC low-water mark (§7): the highest manifest
	// number GCManifests has cleared. The sweep clears (GCManifest, m−K] and
	// advances this ONLY over generations it actually deleted, so a missed or
	// failed warn-only sweep can never permanently strand a manifest below a
	// fixed trailing window — the direct heir of GCLatestSwept's argument.
	// Writer-only; the frontend/service-worker ignore it. omitempty.
	GCManifest int `json:"gcm,omitempty"`
	// Inbox is the per-producer drained watermark of the spool pattern
	// (docs/INBOX-SPEC.md): the highest cycle_id of `inbox/<name>.gz` this store
	// has folded in. Published atomically with the batch it describes by the
	// existing Commit — the same crash argument as Seq/SeenFlag — so a crash
	// before Commit re-drains cleanly and a crash after it skips the stale
	// envelope. Writer-only, like GCLatestSwept/DeltaBytes: the
	// frontend/service-worker ignore it. omitempty; absent == nothing drained.
	// It rides the MANIFEST rather than any other object because that atomicity
	// is the whole crash argument of INBOX-SPEC (§4.4 — non-negotiable).
	Inbox map[string]int64 `json:"inbox,omitempty"`
}

// The retired name-derivation counters (§5.1) used to live here: `seq`, `sf`,
// `gen`, `hdrs`, `mp`, `nd` and `gcs`. Every one of them existed so a reader
// could RECONSTRUCT the name of an object the writer already knew — which is
// exactly what the manifest's explicit name lists (names.go) publish instead.
// They are gone, along with the four GC window formulas and the eight
// per-feature publish-order proofs they anchored. The one crash argument now
// lives once, in manifest.go.

// OutFeed declares one named syndication output: a rolling newest-N window of
// articles from the union of matching tags and explicit feed ids, serialised as
// RSS 2.0 or JSON Feed 1.1 and written to out/<Name>.<ext> each fetch cycle.
type OutFeed struct {
	// Name is the file stem: out/<Name>.rss or out/<Name>.json.
	Name string `json:"name"`
	// Title is the channel/feed title. Defaults to Name when empty.
	Title string `json:"title,omitempty"`
	// Format is "rss" (RSS 2.0) or "json" (JSON Feed 1.1).
	Format string `json:"format"`
	// Tags selects every feed whose Tag field is in this list.
	Tags []string `json:"tags,omitempty"`
	// Feeds selects individual feeds by id.
	Feeds []int `json:"feeds,omitempty"`
	// Limit is the maximum number of items to include (newest first).
	// Defaults to outDefaultLimit when 0.
	Limit int `json:"limit,omitempty"`
	// External marks an externally-updated output: SRR reserves the slot
	// (name, key, listing, rm cleanup) but never generates its bytes —
	// SyncOutFeeds skips it; `srr syndicate push`/`fetch` are the only writers.
	External bool `json:"ext,omitempty"`
}

// withDB opens the DB, runs fn, and ensures Close. Use for commands that
// don't need to manage the parent context themselves.
func withDB(locked bool, fn func(ctx context.Context, db *DB) error) error {
	return withDBCtx(context.Background(), locked, fn)
}

// withDBCtx is the variant for callers that already have a context
// (e.g. signal-aware contexts in long-running commands).
func withDBCtx(ctx context.Context, locked bool, fn func(ctx context.Context, db *DB) error) error {
	if locked {
		release, err := acquireStoreWriter(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	db, err := NewDB(ctx, locked)
	if err != nil {
		return err
	}
	defer db.Close(ctx)
	return fn(ctx, db)
}

// storeWriter serializes store WRITERS inside this process. `.locked` is the
// cross-process lock and stays exactly as it was; this sits in front of it so
// two writers in ONE process (srr serve's background fetch cycle and a GUI
// mutation) queue briefly instead of racing to create `.locked` and handing the
// operator a retry-me 409 for what is really just self-contention. In a
// one-shot CLI process there is a single writer, so it is always uncontended.
//
// A buffered channel rather than sync.Mutex: acquisition must be selectable
// against ctx and a timeout, which Mutex.Lock cannot express.
var storeWriter = make(chan struct{}, 1)

// storeWriterWait bounds that queueing. Past it the caller gets the SAME
// os.ErrExist contract cross-process contention produces (writeErr → 409
// "retry"), so a genuinely long-running cycle still yields a prompt, honest
// answer instead of an unbounded hang.
const storeWriterWait = 30 * time.Second

func acquireStoreWriter(ctx context.Context) (func(), error) {
	t := time.NewTimer(storeWriterWait)
	defer t.Stop()
	select {
	case storeWriter <- struct{}{}:
		return func() { <-storeWriter }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
		return nil, fmt.Errorf("another operation in this process is holding the store: %w", os.ErrExist)
	}
}

func NewDB(ctx context.Context, locked bool) (*DB, error) {
	backend, err := store.Open(ctx, globals.Store)
	if err != nil {
		return nil, err
	}

	db := &DB{
		Backend: backend,
		locked:  locked,
		// A store with no db.gz at all is a fresh v2 store: an empty name table
		// and no feeds. parseStoreRoot replaces both when a root is present.
		core: DBCore{Names: newManifestNames(), Feeds: map[int]*Feed{}},
	}

	if locked {
		if err := db.Put(ctx, dbLockKey, bytes.NewReader(nil), globals.Force); err != nil {
			db.Backend.Close()
			return nil, fmt.Errorf("create lock file: %w", err)
		}
	}

	// The root resolves through parseStoreRoot — the SINGLE root resolver,
	// shared with the read-only tools, so the writer and the checkers can never
	// disagree about what a store's objects are called. No db.gz at all is a
	// fresh v2 store.
	rc, err := db.Get(ctx, dbFileKey, true)
	if err != nil {
		db.Close(ctx)
		return nil, err
	}
	if rc != nil {
		data, err := gunzip(rc)
		rc.Close()
		if err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("decompress %s: %w", dbFileKey, err)
		}
		core, err := parseStoreRoot(data, func(key string) ([]byte, error) { return db.readGz(ctx, key) })
		if err != nil {
			db.Close(ctx)
			return nil, err
		}
		db.core = *core
	}

	// The operator's configuration lives in the backend-only sidecar (§4.3);
	// absence is legal and means all-defaults. A pre-cutover store carries it
	// inline instead, and legacyCore.state() has already lifted it out.
	if db.core.legacyRoot == nil {
		if err := db.loadConfig(ctx); err != nil {
			db.Close(ctx)
			return nil, err
		}
	}

	if db.core.Recipes == nil {
		db.core.Recipes = map[string]Recipe{}
	}
	if _, ok := db.core.Recipes[defaultRecipeName]; !ok {
		db.core.Recipes[defaultRecipeName] = Recipe{Pipe: defaultRootPipe()}
	}

	for id, ch := range db.core.Feeds {
		// An old feeds[]-only db.gz unmarshals to a feed with no top-level
		// url (the legacy feeds key is ignored). Reject it clearly rather than
		// silently fetch nothing.
		if ch.URL == "" {
			db.Close(ctx)
			return nil, fmt.Errorf("feed %d has no url; store predates the feed→feed merge — delete and re-fetch", id)
		}
		ch.id = id
	}

	// The persistent dedup pool rides in the object the manifest names.
	// Missing/short/corrupt ⇒ empty pool + WARN (loadSeen), never fails an open
	// or loses an article — but since bg lives in the sidecar too (see
	// BoundaryGUIDs), a store that lost it degrades all the way to
	// watermark-only dedup until the sidecar refills. Hydrate each feed's
	// sidecar-backed HTTP validators (ETag/LastModified) and BoundaryGUIDs onto
	// the in-memory feeds.
	db.seen = db.loadSeen(ctx)
	db.seen.hydrateFeeds(db.core.Feeds)

	// The one-way cutover (docs/MANIFEST-SPEC.md §11 step 3): a pre-cutover
	// store is migrated by the first LOCKED session that opens it, so everything
	// downstream of this point speaks one layout. Read-only sessions resolve the
	// derived name table in memory and publish nothing.
	if locked && db.core.legacyRoot != nil {
		if err := db.migrateRoot(ctx); err != nil {
			db.Close(ctx)
			return nil, fmt.Errorf("migrate store to format v%d: %w", dbFormatVersion, err)
		}
	}

	// Snapshot the config projection this handle loaded, so Commit can tell a
	// config mutation from an ordinary fetch cycle without re-reading anything
	// (docs/MANIFEST-SPEC.md §4.3 / configChanged). Left nil for a store still on
	// the pre-cutover root: its first commit then bootstraps config.gz
	// unconditionally.
	if db.core.legacyRoot == nil {
		db.configAtOpen = db.snapshotConfig()
	}
	return db, nil
}

func (o *DB) Close(ctx context.Context) error {
	if o.locked {
		if err := o.Rm(context.WithoutCancel(ctx), dbLockKey); err != nil {
			slog.Warn("remove lock file", "error", err)
		}
	}
	return o.Backend.Close()
}

// Commit publishes the store state (docs/MANIFEST-SPEC.md §6.1): three steps in
// a fixed order.
//
//  1. the config sidecar, when this session changed configuration and the
//     change is not a removal (§6.4 — see below);
//  2. the immutable manifest naming every object this generation holds,
//     exclusive-create so a racing writer aborts before it can flip the root
//     (§6.2);
//  3. the root flip — an AtomicPut of the ~60-byte {v, m, t} pointer.
//
// A crash anywhere before step 3 leaves unreferenced objects and changes
// nothing a reader can observe. That is THE crash argument, for the whole
// store, stated once in manifest.go; nothing else in this backend carries a
// publish-order proof of its own any more.
//
// §6.4 ordering for the two-object mutations, both windows inert by §4.3:
//
//   - create / edit: config first, then manifest + root. The window holds
//     config for a feed that does not exist yet.
//   - removal: root first, then config. The window holds config for a feed that
//     no longer exists — writing config first would instead leave a LIVE feed
//     with no config, silently resolving it to the default recipe.
//
// The post-flip config write is warn-only for the same reason every other
// post-commit step is: the state it describes is already durable, and a stale
// entry for a removed feed is inert and swept by the next config write.
func (o *DB) Commit(ctx context.Context) error {
	o.core.Version = dbFormatVersion

	cfgChanged, cfgRemovals := o.configChanged(ctx)
	if cfgChanged && !cfgRemovals {
		if err := o.syncConfig(ctx); err != nil {
			return err
		}
	}
	if err := o.publishManifest(ctx); err != nil {
		return err
	}

	body, err := gzipJSON(RootState{
		Version:     dbFormatVersion,
		ManifestNum: o.core.ManifestNum,
		FetchedAt:   o.core.FetchedAt,
	})
	if err != nil {
		return err
	}
	if err := o.AtomicPut(ctx, dbFileKey, bytes.NewReader(body), store.ObjectMeta{}); err != nil {
		return err
	}

	if cfgChanged && cfgRemovals {
		if err := o.syncConfig(context.WithoutCancel(ctx)); err != nil {
			slog.Warn("write config sidecar after removal", "error", err)
		}
	}
	// Everything the cutover superseded and no manifest will ever name (the db/
	// snapshot series, the retired seen ping/pong slots) goes now that its
	// replacement is durable. Post-flip and warn-only, like every other
	// reclamation step.
	o.reapLegacy(context.WithoutCancel(ctx))
	return nil
}

func (o *DB) Feeds() map[int]*Feed {
	return o.core.Feeds
}

func (o *DB) AddFeed(c *Feed) error {
	if o.core.Feeds == nil {
		o.core.Feeds = map[int]*Feed{}
	}
	for id := range feedIDCeiling {
		if _, ok := o.core.Feeds[id]; !ok {
			c.id = id
			c.AddIdx = o.core.TotalArticles
			c.Expired = 0 // fresh incarnation has expired nothing (id-reuse invariant, local by construction)
			o.core.Feeds[id] = c
			return nil
		}
	}
	return fmt.Errorf("maximum number of feeds reached (%d)", feedIDCeiling)
}

// RemoveFeed unsubscribes id. The id-reuse hazard it must guard: the
// consolidation replay derives its as-of-chron header counts from the LIVE feed
// set, so if this id's articles sit in an unconsolidated delta chain when a
// later add REUSES the freed id, the dead incarnation's in-chain entries become
// indistinguishable from the new feed's during the replay, permanently
// corrupting the finalized headers it writes.
//
// The guard only bites when THIS feed actually has an entry in the live chain,
// so removal drains the chain ONLY then; a feed with no chain entry (a dormant
// feed that hasn't posted within the chain window — the common case) is removed
// with no consolidation at all, because a reused id can never confuse a chain
// that holds none of the old incarnation's articles. That means most removals
// need only to READ+parse the chain (to check membership), not write it, so a
// dormant feed stays removable even when a consolidation would fail. Only a
// chain that can't be parsed at all (a corrupt segment, an unreachable store)
// blocks removal — the store genuinely needs repair first (there is no safe
// automatic recovery: dropping the unconsolidated articles can't fix the
// per-feed counts an unparseable chain can't be read for).
func (o *DB) RemoveFeed(ctx context.Context, id int) error {
	if o.core.numDeltas() > 0 {
		chain, err := o.loadDeltaChain(ctx)
		if err != nil {
			return fmt.Errorf("cannot remove feed %d: its delta chain must be verified first and reading it failed — repair the store, then retry: %w", id, err)
		}
		inChain := false
		for i := range chain.Arts {
			if chain.Arts[i].FeedID == id {
				inChain = true
				break
			}
		}
		if inChain {
			if err := o.DrainDeltas(ctx); err != nil {
				return fmt.Errorf("cannot remove feed %d: its articles are in the live delta chain, which must consolidate first, and that failed — repair the store, then retry: %w", id, err)
			}
		}
	}
	delete(o.core.Feeds, id)
	// Purge the feed's seen.gz state now (dedup entries + HTTP validators), so a
	// reused id can't inherit it. Callers persist via commitState (which also
	// publishes any drain's generation bump). See dropFeed.
	o.seen.dropFeed(id)
	return nil
}

func (o *DB) FeedByID(id int) (*Feed, error) {
	if id < 0 || id >= feedIDCeiling {
		return nil, fmt.Errorf("feed id must be in [0, %d]", feedIDCeiling-1)
	}
	ch := o.core.Feeds[id]
	if ch == nil {
		// Wrap the stdlib not-exist sentinel so callers can classify this
		// STRUCTURALLY (serve's writeErr maps it to 404) instead of matching the
		// message text — which silently 404s any future error whose wording
		// happens to contain "not found". fs.ErrNotExist keeps the repo's
		// "no new custom sentinels" convention.
		return nil, fmt.Errorf("feed id %d not found: %w", id, fs.ErrNotExist)
	}
	return ch, nil
}

func (o *DB) readGz(ctx context.Context, key string) ([]byte, error) {
	rc, err := o.Get(ctx, key, false)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", key, err)
	}
	defer rc.Close()
	out, err := gunzip(rc)
	if err != nil {
		return nil, fmt.Errorf("decompress %s: %w", key, err)
	}
	return out, nil
}
