package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
)

// InspectCmd mirrors the frontend's bounds-based pack lookup
// (frontend/src/js/idx.ts + data.ts) so a pass here means the read
// path the browser uses is consistent with the pack files on disk.
type InspectCmd struct {
	URL      string `optional:"" help:"HTTP base URL (e.g., http://localhost:3000). Overrides --store."`
	Chron    int    `default:"-1" help:"Inspect a specific chronIdx; omit for other modes."`
	Validate bool   `help:"Walk every chronIdx and report any pack inconsistency (bounds, db meta, chanCounts/fetchedAts continuity, unknown chan_ids, latest-pack files)."`
	Filter   string `help:"Tag name or numeric chan_id; reports count and chron range matching the filter (mirrors frontend filter logic)."`
	Floor    int    `default:"0" help:"Optional floor chronIdx for --filter."`
	FromHash string `help:"Replay nav.fromHash on a frontend URL hash like '0,2485!big_info': resolves filter, decides resolve()/last(), prints final article."`
	ListTags bool   `help:"List tags and their channel/article counts (mirrors frontend groupChannelsByTag)."`
}

type inspBound struct {
	packID     int
	startChron int
}

type inspIdx struct {
	packIndex     int
	packSize      int
	chanIDs       []byte
	fetchedAts    []uint32 // per-entry cumulative fetched_at (8h blocks since first_fetched)
	bounds        []inspBound
	fetchedAtBase uint32
	packIDBase    uint32
	packOffBase   uint32
	chanCounts    [256]uint32 // from header (cumulative before this pack)
	ownChanCounts [256]uint32 // counted during parse (in this pack only)
}

type keyGetter func(key string) ([]byte, error)

func (o *InspectCmd) Run() error {
	ctx := context.Background()
	fetch, cleanup, err := o.openFetcher(ctx)
	if err != nil {
		return err
	}
	if cleanup != nil {
		defer cleanup()
	}

	core, err := loadCore(fetch)
	if err != nil {
		return err
	}
	fmt.Printf("db: total_art=%d  next_pid=%d  data_tog=%v  pack_off=%d  first_fetched=%d\n",
		core.TotalArticles, core.NextPackID, core.DataToggle, core.PackOffset, core.FirstFetchedAt)

	if core.TotalArticles == 0 {
		fmt.Println("no articles")
		return nil
	}

	packs, err := loadIdxPacks(fetch, core)
	if err != nil {
		return err
	}
	for _, p := range packs {
		fmt.Printf("idx pack %d: %d entries, %d bounds (first=%+v last=%+v)\n",
			p.packIndex, p.packSize, len(p.bounds), p.bounds[0], p.bounds[len(p.bounds)-1])
	}

	if o.Validate {
		return validateAll(fetch, core, packs)
	}
	if o.ListTags {
		return listTagsReport(core)
	}
	if o.FromHash != "" {
		return fromHashReport(fetch, core, packs, o.FromHash)
	}
	if o.Filter != "" {
		return filterReport(core, packs, o.Filter, o.Floor)
	}
	if o.Chron < 0 {
		fmt.Println("(use --chron, --validate, --filter, --from-hash, or --list-tags)")
		return nil
	}
	return inspectOne(fetch, core, packs, o.Chron)
}

func (o *InspectCmd) openFetcher(ctx context.Context) (keyGetter, func(), error) {
	if o.URL != "" {
		return httpFetcher(o.URL), nil, nil
	}
	db, err := NewDB(ctx, false)
	if err != nil {
		return nil, nil, err
	}
	return func(key string) ([]byte, error) {
		return db.readGz(ctx, key)
	}, func() { db.Close(ctx) }, nil
}

func httpFetcher(base string) keyGetter {
	return func(key string) ([]byte, error) {
		u, err := url.JoinPath(base, key)
		if err != nil {
			return nil, err
		}
		res, err := http.Get(u)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: %d", u, res.StatusCode)
		}
		data, err := gunzip(res.Body)
		if err != nil {
			return nil, fmt.Errorf("gunzip %s: %w", key, err)
		}
		return data, nil
	}
}

func loadCore(fetch keyGetter) (*DBCore, error) {
	data, err := fetch(dbFileKey)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", dbFileKey, err)
	}
	var c DBCore
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("decode %s: %w", dbFileKey, err)
	}
	return &c, nil
}

func loadIdxPacks(fetch keyGetter, core *DBCore) ([]*inspIdx, error) {
	numFinalized := (core.TotalArticles - 1) / idxPackSize
	out := make([]*inspIdx, numFinalized+1)
	for p := 0; p <= numFinalized; p++ {
		var key string
		if p < numFinalized {
			key = fmt.Sprintf("idx/%d.gz", p)
		} else {
			key = fmt.Sprintf("idx/%v.gz", core.DataToggle)
		}
		size := idxPackSize
		if p == numFinalized {
			size = core.TotalArticles - p*idxPackSize
		}
		buf, err := fetch(key)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", key, err)
		}
		pack, err := parseInspIdx(buf, p, size)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", key, err)
		}
		out[p] = pack
	}
	return out, nil
}

// parseInspIdx is the byte-for-byte mirror of
// frontend/src/js/idx.ts makeIdxPack().parse().
func parseInspIdx(buf []byte, packIndex, packSize int) (*inspIdx, error) {
	if len(buf) < idxHeaderSize {
		return nil, fmt.Errorf("short header: %d < %d", len(buf), idxHeaderSize)
	}
	expected := idxHeaderSize + packSize*2
	if len(buf) < expected {
		return nil, fmt.Errorf("short body: have %d, want %d (header+%d entries)", len(buf), expected, packSize)
	}

	pack := &inspIdx{
		packIndex:     packIndex,
		packSize:      packSize,
		chanIDs:       make([]byte, packSize),
		fetchedAts:    make([]uint32, packSize),
		fetchedAtBase: binary.LittleEndian.Uint32(buf[0:]),
		packIDBase:    binary.LittleEndian.Uint32(buf[4:]),
		packOffBase:   binary.LittleEndian.Uint32(buf[8:]),
	}
	for s := range 256 {
		pack.chanCounts[s] = binary.LittleEndian.Uint32(buf[12+s*4:])
	}

	packID := int(pack.packIDBase)
	packOff := int(pack.packOffBase)
	fetchedAt := pack.fetchedAtBase
	baseChron := packIndex * idxPackSize
	if packOff > 0 {
		pack.bounds = append(pack.bounds, inspBound{packID, baseChron - packOff})
	}
	for i := range packSize {
		off := idxHeaderSize + i*2
		packed := buf[off+1]
		if packed>>7 != 0 {
			packID++
		}
		fetchedAt += uint32(packed & 0x7F)
		sub := buf[off]
		pack.chanIDs[i] = sub
		pack.fetchedAts[i] = fetchedAt
		pack.ownChanCounts[sub]++
		if len(pack.bounds) == 0 || pack.bounds[len(pack.bounds)-1].packID != packID {
			pack.bounds = append(pack.bounds, inspBound{packID, baseChron + i})
		}
	}
	return pack, nil
}

// getPackRef mirrors frontend/src/js/data.ts getPackRef().
func (p *inspIdx) getPackRef(chron int) (packID, offset int) {
	idx := sort.Search(len(p.bounds), func(i int) bool {
		return p.bounds[i].startChron > chron
	}) - 1
	b := p.bounds[idx]
	return b.packID, chron - b.startChron
}

func packIdxFor(chron, n int) int {
	p := chron / idxPackSize
	if p >= n {
		return n - 1
	}
	return p
}

func loadDataPack(fetch keyGetter, key string) ([]ArticleData, error) {
	data, err := fetch(key)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", key, err)
	}
	entries, err := parseDataPack(data)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", key, err)
	}
	return entries, nil
}

func truncStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
