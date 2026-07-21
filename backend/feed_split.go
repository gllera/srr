package main

// The per-feed half of the content split — docs/MANIFEST-SPEC.md §5.2.
//
// A feed's fields divide on one axis, and it is NOT "is it operator-authored":
// it is DOES THE READER CONSUME IT. `exp` (retention days) is operator config
// and is nonetheless rendered by the reader's info card, so it stays public;
// `dd`/`dt` tune the same dedup machinery and are never read by anyone but the
// writer, so they leave. Splitting on authorship instead would have broken the
// reader for no gain.
//
//   - FeedPublic → the manifest's feeds{} (public, reader-consumed)
//   - FeedConfig → the backend-only config.gz sidecar
//   - the rest   → json:"-" already: the seen.gz sidecar (etag/last_modified/bg)
//     and pure in-memory scratch
//
// Feed itself deliberately stays FLAT rather than embedding these two structs.
// Embedding would serialize identically (encoding/json flattens anonymous
// fields) and would make the projections a field-free value copy — but Go
// forbids promoted fields in composite literals, and `Feed{Title: …}` appears
// in ~380 places. The exhaustiveness this file would have got from the type
// system it gets from TestFeedSplitCoversEveryWireField instead: that test
// walks Feed's json tags and fails if any is missing from — or duplicated
// across — the two projections. Adding a field to Feed without deciding where
// it goes is a test failure, not a silent omission.

// FeedPublic is the reader-facing half of a feed: exactly what the manifest
// publishes. Tags are identical to Feed's, so a manifest feed entry is
// byte-compatible with the corresponding subset of a db.gz feed entry.
type FeedPublic struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	// Watermark is the max published unix-second ever seen across fetches.
	// Reader-displayed ("Latest published" in the info card), so it stays
	// public even though it is fetch state.
	Watermark  int64  `json:"wm,omitempty"`
	FetchError string `json:"ferr,omitempty"`
	// LastOK / FailStreak / LastNew are the per-feed fetch-health vitals behind
	// the reader's health grade.
	LastOK     int64  `json:"last_ok,omitempty"`
	FailStreak int    `json:"fail_streak,omitempty"`
	LastNew    int64  `json:"last_new,omitempty"`
	Tag        string `json:"tag,omitempty"`
	// NoTitle is a reader-consumed contract flag (the frontend hides the
	// article heading for titleless microblog-style feeds).
	NoTitle bool `json:"nt,omitempty"`
	// ExpireDays is operator config that the reader nonetheless renders
	// ("Retention"), so it is public — see the file comment.
	ExpireDays   int   `json:"exp,omitempty"`
	Expired      int   `json:"xp,omitempty"`
	TotalArt     int   `json:"total_art"`
	AddIdx       int   `json:"add_idx"`
	ContentBytes int64 `json:"cb,omitempty"`
	AssetBytes   int64 `json:"ab,omitempty"`
}

// FeedConfig is the backend-only half: the processing and dedup knobs the
// frontend and service worker have never read. These are the fields that stop
// being published to the world once S34 flips the root — the "strictly smaller
// change than going private" docs/STORE-VISIBILITY.md named as the natural
// first step.
type FeedConfig struct {
	Recipe string   `json:"recipe,omitempty"`
	Ingest string   `json:"ingest,omitempty"`
	Pipe   []string `json:"pipe,omitempty"`
	// DedupDays / DedupTitle tune the persistent seen.gz pool per feed.
	DedupDays  int  `json:"dd,omitempty"`
	DedupTitle bool `json:"dt,omitempty"`
}

// feedPublicOf projects a feed onto its manifest half.
func feedPublicOf(f *Feed) FeedPublic {
	return FeedPublic{
		Title:        f.Title,
		URL:          f.URL,
		Watermark:    f.Watermark,
		FetchError:   f.FetchError,
		LastOK:       f.LastOK,
		FailStreak:   f.FailStreak,
		LastNew:      f.LastNew,
		Tag:          f.Tag,
		NoTitle:      f.NoTitle,
		ExpireDays:   f.ExpireDays,
		Expired:      f.Expired,
		TotalArt:     f.TotalArt,
		AddIdx:       f.AddIdx,
		ContentBytes: f.ContentBytes,
		AssetBytes:   f.AssetBytes,
	}
}

// feedConfigOf projects a feed onto its config-sidecar half.
func feedConfigOf(f *Feed) FeedConfig {
	return FeedConfig{
		Recipe:     f.Recipe,
		Ingest:     f.Ingest,
		Pipe:       f.Pipe,
		DedupDays:  f.DedupDays,
		DedupTitle: f.DedupTitle,
	}
}

// isZero reports whether a feed carries no configuration at all, so the sidecar
// can omit its entry entirely (§4.3: an absent entry means "all defaults", the
// same thing an all-zero entry would mean).
func (c FeedConfig) isZero() bool {
	return c.Recipe == "" && c.Ingest == "" && len(c.Pipe) == 0 && c.DedupDays == 0 && !c.DedupTitle
}
