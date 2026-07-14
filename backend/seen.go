package main

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"slices"

	"srr/store"
)

// The seen.gz pool is SRR's persistent, age-bounded dedup memory: a
// backend-only sidecar (a third mutable store-root class after db.gz and out/)
// remembering, per feed, the last day each item GUID (and optionally folded
// title) was present in the feed window. It catches re-promotion duplicates —
// a feed re-publishing an old item with a fresh pubDate but a stable GUID that
// has fallen out of the small db.gz BoundaryGUIDs snapshot — which neither the
// watermark (the re-dated pub sits above it) nor bg (the GUID aged out) can.
// The reader never fetches it; a missing/corrupt pool degrades to exact
// bg-only dedup, never an article loss. See backend/SEEN-POOL-PLAN.md.

const (
	// seenLegacyKey is the pre-ping-pong single-object name. Read once as a
	// migration bridge when neither slot exists; never written.
	seenLegacyKey = "seen.gz"
	// defaultDedupDays is the horizon used when neither the feed nor the store
	// sets one. The reported re-promotion gaps are days wide, so 30 is generous.
	defaultDedupDays = 30
	// seenFeedCap bounds a single feed's retained entries so a firehose can't
	// grow the pool without limit under pure age eviction. A feed over the cap
	// keeps only its newest seenFeedCap by when — sacrificing only its own
	// horizon, never another feed's (age eviction's whole point). Size it
	// against the chosen horizon for high-volume feeds: cap ≳ H × peak_daily.
	seenFeedCap = 4096
	// dedupDisabled is the non-positive horizon a feed's dedupDays returns when
	// the feed opts out (Feed.DedupDays == -1): seenBefore treats it as bg-only,
	// and evict drops any residual entries for it.
	dedupDisabled = -1

	seenMagic   = "SEEN"
	seenVersion = 1
	// seenHeaderLen is magic(4) + version(1) + count u32(4).
	seenHeaderLen = 9
	// seenRowLen is the per-entry on-disk size across the three columns:
	// feed_id u16 + when u16 + hash u32.
	seenRowLen = 2 + 2 + 4
)

// seenSlotKey returns the store key of the seen slot named by flag: false ⇒
// seen.0.gz, true ⇒ seen.1.gz. The active slot is seenSlotKey(core.SeenFlag);
// a dirty cycle writes seenSlotKey(!core.SeenFlag) then flips the flag.
func seenSlotKey(flag bool) string {
	if flag {
		return "seen.1.gz"
	}
	return "seen.0.gz"
}

// seenPool is the in-memory pool: one flat map keyed feed_id<<32 | hash →
// when_seen (absolute unix-day). Reads (has) are lock-free — the pool is the
// cycle-start snapshot, immutable during the concurrent feed fan-out; stamps
// are buffered per feed and merged single-threaded after the fan-out. Every
// method is nil-receiver-safe so the fetch tests' pool-less fetchRun literals
// (and a disabled / never-loaded pool) don't panic.
type seenPool struct {
	// dirty is set by stamp/evict/snapshotHTTP when they actually mutate the
	// pool; SyncSeen skips the store write when it is false (most --interval
	// cycles are all-304 no-ops), and clears it after a successful write.
	dirty bool
	m     map[uint64]uint16
	// http holds each feed's HTTP conditional-fetch validators (ETag /
	// Last-Modified). These are backend-only fetch state that used to ride in the
	// hot db.gz; they live here now so the one no-cache object every reader
	// re-downloads stays lean. Keyed by feed_id; a feed with neither validator
	// holds no entry. Loaded onto the in-memory feeds by hydrateFeeds and pulled
	// back by snapshotHTTP.
	http map[int]httpState
}

// httpState is a feed's HTTP conditional-fetch validators as persisted in
// seen.gz.
type httpState struct {
	etag    string
	lastMod string
}

func newSeenPool() *seenPool {
	return &seenPool{m: map[uint64]uint16{}, http: map[int]httpState{}}
}

// seenKey packs a feed id and a u32 hash into the pool's map key. feed_id is a
// uint16 in every idx entry (feedIDCeiling bound), so the top 32 bits never
// overflow the shifted id.
func seenKey(feedID int, h uint32) uint64 { return uint64(uint16(feedID))<<32 | uint64(h) }

// fnv32 is FNV-32a, byte-for-byte identical to ingest.hash (ingest/feed.go), so
// a folded-title hash lands in the same u32 keyspace the ingest layer stamps
// item GUIDs into — membership (has) is the OR over both axes.
func fnv32(s string) uint32 {
	const (
		offset32 = 2166136261
		prime32  = 16777619
	)
	h := uint32(offset32)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= prime32
	}
	return h
}

// titleHash hashes a folded title (foldSearchText, the same folding the search
// blooms use) into the shared per-feed keyspace. Two titles that fold to the
// same tokens collide — the intended title-dedup behavior.
func titleHash(title string) uint32 { return fnv32(foldSearchText(title)) }

// has reports whether (feedID, hash) is remembered. Pure read: no lazy init, no
// memoization, so concurrent fan-out readers need no lock.
func (p *seenPool) has(feedID int, h uint32) bool {
	if p == nil {
		return false
	}
	_, ok := p.m[seenKey(feedID, h)]
	return ok
}

// stamp records that (feedID, hash) was present on day. Write-if-changed: a
// re-stamp of the identical day is a no-op that leaves dirty untouched, so an
// unchanged window within one day never forces a store rewrite.
func (p *seenPool) stamp(feedID int, h uint32, day uint16) {
	if p == nil {
		return
	}
	k := seenKey(feedID, h)
	if old, ok := p.m[k]; !ok || old != day {
		p.m[k] = day
		p.dirty = true
	}
}

// evict applies, in one pass, the three bounds that keep the pool correct and
// finite: it drops entries for any feed_id absent from live (id-reuse hygiene —
// a removed or reused id shares no dedup history), entries a live feed's horizon
// has aged out (today-when > H, or the feed opted out ⇒ dedupDisabled), and,
// per feed, everything beyond the newest capPerFeed by when (the flood cap).
// horizonFor returns a feed's effective horizon in days (positive) or
// dedupDisabled. Called once per fetch cycle, single-threaded, after the merge.
func (p *seenPool) evict(today uint16, horizonFor func(feedID int) int, capPerFeed int, live map[int]*Feed) {
	if p == nil {
		return
	}
	type ent struct {
		key  uint64
		when uint16
	}
	perFeed := map[int][]ent{}
	for k, when := range p.m {
		fid := int(uint16(k >> 32))
		if _, ok := live[fid]; !ok {
			delete(p.m, k) // dead / reused feed id: no shared history
			p.dirty = true
			continue
		}
		h := horizonFor(fid)
		if h <= 0 || int(today)-int(when) > h {
			delete(p.m, k) // disabled feed, or aged past its horizon
			p.dirty = true
			continue
		}
		perFeed[fid] = append(perFeed[fid], ent{k, when})
	}
	for _, ents := range perFeed {
		if len(ents) <= capPerFeed {
			continue
		}
		// Keep the newest capPerFeed by when; ties broken by key for
		// determinism. A feed over the cap sacrifices only its own horizon.
		slices.SortFunc(ents, func(a, b ent) int {
			if a.when != b.when {
				return cmp.Compare(b.when, a.when) // newest first
			}
			return cmp.Compare(a.key, b.key)
		})
		for _, e := range ents[capPerFeed:] {
			delete(p.m, e.key)
			p.dirty = true
		}
	}
}

// dropFeed purges every trace of a feed id from the pool — its dedup entries
// and its HTTP validators — dirtying the pool if anything was removed. Called
// synchronously by RemoveFeed so a removed id, if immediately reused by a new
// feed (AddFeed picks the smallest free id, with no fetch cycle in between to
// let evict observe the gap), starts with no dedup history. evict's dead-feed
// sweep remains a belt-and-suspenders for ids that go dead and stay dead.
func (p *seenPool) dropFeed(feedID int) {
	if p == nil {
		return
	}
	for k := range p.m {
		if int(uint16(k>>32)) == feedID {
			delete(p.m, k)
			p.dirty = true
		}
	}
	if _, ok := p.http[feedID]; ok {
		delete(p.http, feedID)
		p.dirty = true
	}
}

// hydrateFeeds copies the pool's persisted HTTP validators onto the in-memory
// feeds (ETag/LastModified are seen.gz-backed now, json:"-" in db.gz). A feed
// with no entry keeps its zero values — a fresh source with no cache history.
// Called by NewDB after the pool loads.
func (p *seenPool) hydrateFeeds(live map[int]*Feed) {
	if p == nil {
		return
	}
	for id, hs := range p.http {
		if ch := live[id]; ch != nil {
			ch.ETag = hs.etag
			ch.LastModified = hs.lastMod
		}
	}
}

// snapshotHTTP pulls each live feed's current ETag/LastModified back into the
// pool (dirtying it when any changed) and drops entries for feeds that are no
// longer live (id reuse / removal). A feed with neither validator holds no
// entry. Called by SyncSeen, so every persist of feed state carries the current
// validators — a fetch that refreshed an ETag, or a setFeedURL reset that
// cleared one.
func (p *seenPool) snapshotHTTP(live map[int]*Feed) {
	if p == nil {
		return
	}
	for id, ch := range live {
		want := httpState{etag: ch.ETag, lastMod: ch.LastModified}
		if want == (httpState{}) {
			if _, ok := p.http[id]; ok {
				delete(p.http, id)
				p.dirty = true
			}
			continue
		}
		if p.http[id] != want {
			p.http[id] = want
			p.dirty = true
		}
	}
	for id := range p.http {
		if _, ok := live[id]; !ok {
			delete(p.http, id)
			p.dirty = true
		}
	}
}

// marshal serializes the pool to the on-disk body (pre-gzip): a fixed header,
// then the dedup section as three separate columns (feed_id, when, hash) sorted
// by (feed_id, when, hash) so the two non-hash columns gzip-RLE well while the
// random hashes stay at their ~4 B/entry entropy floor, then the HTTP-validator
// section (a length-prefixed per-feed record). See §4 of the plan.
func (p *seenPool) marshal() []byte {
	type row struct {
		fid  uint16
		when uint16
		h    uint32
	}
	rows := make([]row, 0, len(p.m))
	for k, when := range p.m {
		rows = append(rows, row{uint16(k >> 32), when, uint32(k)})
	}
	slices.SortFunc(rows, func(a, b row) int {
		if a.fid != b.fid {
			return cmp.Compare(a.fid, b.fid)
		}
		if a.when != b.when {
			return cmp.Compare(a.when, b.when)
		}
		return cmp.Compare(a.h, b.h)
	})

	n := len(rows)
	buf := make([]byte, 0, seenHeaderLen+n*seenRowLen)
	buf = append(buf, seenMagic...)
	buf = append(buf, seenVersion)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(n))
	for _, r := range rows {
		buf = binary.LittleEndian.AppendUint16(buf, r.fid)
	}
	for _, r := range rows {
		buf = binary.LittleEndian.AppendUint16(buf, r.when)
	}
	for _, r := range rows {
		buf = binary.LittleEndian.AppendUint32(buf, r.h)
	}

	// HTTP-validator section: count, then per feed (sorted by id for a
	// deterministic file) feed_id + length-prefixed etag + length-prefixed
	// last_modified.
	ids := make([]int, 0, len(p.http))
	for id := range p.http {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(ids)))
	for _, id := range ids {
		hs := p.http[id]
		buf = binary.LittleEndian.AppendUint16(buf, uint16(id))
		buf = appendLenPrefixed(buf, hs.etag)
		buf = appendLenPrefixed(buf, hs.lastMod)
	}
	return buf
}

// appendLenPrefixed writes a u16 LE length then the string bytes. Validators are
// short HTTP header tokens (etags, HTTP-dates), well under the u16 ceiling.
func appendLenPrefixed(buf []byte, s string) []byte {
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(s)))
	return append(buf, s...)
}

// parseSeen decodes a marshal() body back into a pool. A bad magic/version, a
// truncated section, or trailing bytes is a corruption error: the caller
// (loadSeen) degrades to an empty pool with a WARN — never an article loss.
func parseSeen(data []byte) (*seenPool, error) {
	if len(data) < seenHeaderLen {
		return nil, fmt.Errorf("seen: short body (%d bytes)", len(data))
	}
	if string(data[:4]) != seenMagic {
		return nil, fmt.Errorf("seen: bad magic %q", data[:4])
	}
	if data[4] != seenVersion {
		return nil, fmt.Errorf("seen: unsupported version %d", data[4])
	}
	n := int(binary.LittleEndian.Uint32(data[5:seenHeaderLen]))

	// Dedup section: three columns of n entries.
	pos := seenHeaderLen
	if n < 0 || len(data)-pos < n*seenRowLen {
		return nil, fmt.Errorf("seen: truncated dedup section (%d entries, %d bytes left)", n, len(data)-pos)
	}
	p := newSeenPool()
	fidOff := pos
	whenOff := fidOff + n*2
	hashOff := whenOff + n*2
	for i := range n {
		fid := binary.LittleEndian.Uint16(data[fidOff+i*2:])
		when := binary.LittleEndian.Uint16(data[whenOff+i*2:])
		h := binary.LittleEndian.Uint32(data[hashOff+i*4:])
		p.m[seenKey(int(fid), h)] = when
	}
	pos = hashOff + n*4

	// HTTP-validator section: count, then per-feed length-prefixed records.
	if len(data)-pos < 4 {
		return nil, fmt.Errorf("seen: missing http section")
	}
	m := int(binary.LittleEndian.Uint32(data[pos:]))
	pos += 4
	for range m {
		if len(data)-pos < 2 {
			return nil, fmt.Errorf("seen: truncated http record")
		}
		fid := int(binary.LittleEndian.Uint16(data[pos:]))
		pos += 2
		etag, np, err := readLenPrefixed(data, pos)
		if err != nil {
			return nil, err
		}
		lastMod, np2, err := readLenPrefixed(data, np)
		if err != nil {
			return nil, err
		}
		pos = np2
		p.http[fid] = httpState{etag: etag, lastMod: lastMod}
	}
	if pos != len(data) {
		return nil, fmt.Errorf("seen: %d trailing bytes", len(data)-pos)
	}
	return p, nil
}

// readLenPrefixed reads a u16 LE length then that many bytes as a string,
// returning the value and the new cursor.
func readLenPrefixed(data []byte, pos int) (string, int, error) {
	if len(data)-pos < 2 {
		return "", 0, fmt.Errorf("seen: truncated length prefix")
	}
	n := int(binary.LittleEndian.Uint16(data[pos:]))
	pos += 2
	if len(data)-pos < n {
		return "", 0, fmt.Errorf("seen: string overruns body (%d bytes, %d left)", n, len(data)-pos)
	}
	return string(data[pos : pos+n]), pos + n, nil
}

// loadSeen reads and parses seen.gz into a pool. A missing object, a read error,
// a bad gzip stream, or a corrupt body all degrade to an empty pool with a WARN
// — dedup falls back to bg-only, never a failed open or an article loss. The
// returned pool is always non-nil and clean.
func (o *DB) loadSeen(ctx context.Context) *seenPool {
	rc, err := o.Get(ctx, seenLegacyKey, true)
	if err != nil {
		slog.Warn("read seen pool; using empty", "error", err)
		return newSeenPool()
	}
	if rc == nil {
		return newSeenPool() // absent: first run / never written
	}
	data, err := gunzip(rc)
	rc.Close()
	if err != nil {
		slog.Warn("decompress seen pool; using empty", "error", err)
		return newSeenPool()
	}
	p, err := parseSeen(data)
	if err != nil {
		slog.Warn("parse seen pool; using empty", "error", err)
		return newSeenPool()
	}
	return p
}

// SyncSeen persists the pool to seen.gz when it changed (dirty). It first pulls
// every live feed's current HTTP validators into the pool (snapshotHTTP), so a
// fetch that refreshed an ETag or a setFeedURL reset that cleared one is
// captured. It is called AFTER Commit (the reverse of hdrs/mp, which must
// precede their db.gz publish): the article batch is already durable in
// L<Seq+1>, so a pool write that lags a cycle risks at most one duplicate next
// cycle — today's behavior — whereas a pre-Commit write whose commit then failed
// would mark never-published GUIDs as seen and drop them forever. A lagging
// HTTP validator is likewise harmless — the server returns a full 200 and dedup
// suppresses the repeats. Warn-only at the call site, like SyncMeta. On an idle
// (all-304) cycle the pool is clean and this is a no-op.
func (o *DB) SyncSeen(ctx context.Context) error {
	if o.seen == nil {
		return nil
	}
	o.seen.snapshotHTTP(o.core.Feeds)
	if !o.seen.dirty {
		return nil
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(o.seen.marshal()); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := o.AtomicPut(ctx, seenLegacyKey, &buf, store.ObjectMeta{}); err != nil {
		return err
	}
	o.seen.dirty = false
	return nil
}

// commitState publishes db.gz (Commit) and then the seen.gz sidecar (SyncSeen),
// used by the feed-mutation commands so a setFeedURL fetch-state reset — which
// clears the seen.gz-backed ETag/LastModified — reaches the sidecar too. The
// SyncSeen is warn-only, like in the fetch path: a failed sidecar write degrades
// to a redundant fetch next cycle, it never blocks the db.gz commit.
func (o *DB) commitState(ctx context.Context) error {
	if err := o.Commit(ctx); err != nil {
		return err
	}
	if err := o.SyncSeen(ctx); err != nil {
		slog.Warn("sync seen pool", "error", err)
	}
	return nil
}
