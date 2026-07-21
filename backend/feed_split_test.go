package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// wireTags returns the json key of every serializable field of a struct type,
// mapped to its Go field name. json:"-" and unexported fields are skipped.
func wireTags(t reflect.Type) map[string]string {
	out := map[string]string{}
	for i := range t.NumField() {
		f := t.Field(i)
		if f.PkgPath != "" {
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		out[name] = f.Name
	}
	return out
}

// TestFeedSplitCoversEveryWireField is the exhaustiveness guarantee Feed gives
// up by staying flat instead of embedding FeedPublic/FeedConfig (see
// feed_split.go's file comment): every field db.gz publishes for a feed must
// land in exactly one of the two projections. A new Feed field that nobody
// routed is a failure here, not a field silently missing from the manifest —
// which, since nothing reads the manifest until S33, would otherwise surface
// only after the store's root had already flipped.
func TestFeedSplitCoversEveryWireField(t *testing.T) {
	feed := wireTags(reflect.TypeOf(Feed{}))
	pub := wireTags(reflect.TypeOf(FeedPublic{}))
	cfg := wireTags(reflect.TypeOf(FeedConfig{}))

	for key, field := range feed {
		_, inPub := pub[key]
		_, inCfg := cfg[key]
		switch {
		case inPub && inCfg:
			t.Errorf("Feed.%s (json %q) is in BOTH FeedPublic and FeedConfig — pick one", field, key)
		case !inPub && !inCfg:
			t.Errorf("Feed.%s (json %q) is in NEITHER FeedPublic nor FeedConfig: "+
				"route it per docs/MANIFEST-SPEC.md §5.2 (does the reader consume it?)", field, key)
		}
	}
	for key := range pub {
		if _, ok := feed[key]; !ok {
			t.Errorf("FeedPublic has json %q, which Feed does not publish", key)
		}
	}
	for key := range cfg {
		if _, ok := feed[key]; !ok {
			t.Errorf("FeedConfig has json %q, which Feed does not publish", key)
		}
	}
}

// TestFeedProjectionsRoundTripValues pins that the projections actually copy
// the values — a field routed in the type check above but forgotten in
// feedPublicOf/feedConfigOf would otherwise publish a zero.
func TestFeedProjectionsRoundTripValues(t *testing.T) {
	f := &Feed{
		Title: "T", URL: "https://e/f", Watermark: 11, FetchError: "boom",
		LastOK: 12, FailStreak: 3, LastNew: 13, Tag: "news/tech", NoTitle: true,
		ExpireDays: 30, Expired: 4, TotalArt: 5, AddIdx: 6, ContentBytes: 7, AssetBytes: 8,
		Recipe: "r", Ingest: "#feed", Pipe: []string{"#a"}, DedupDays: -1, DedupTitle: true,
	}
	full, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := json.Unmarshal(full, &want); err != nil {
		t.Fatal(err)
	}

	// The two halves, re-merged, must reproduce db.gz's feed object exactly.
	got := map[string]any{}
	for _, half := range []any{feedPublicOf(f), feedConfigOf(f)} {
		b, err := json.Marshal(half)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		for k, v := range m {
			got[k] = v
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("feedPublicOf ⊎ feedConfigOf != the db.gz feed object\n got: %v\nwant: %v", got, want)
	}
}

// TestDBCoreGroupsCoverEveryWireField is the DBCore counterpart. DBCore IS
// structurally split (it embeds its four groups), so encoding/json guarantees
// coverage by construction — what this pins is the other direction: that the
// grouping never leaks into the wire shape. db.gz must keep exactly the flat
// key set every deployed reader parses, plus only the deliberately additive
// `m`/`gcm`.
func TestDBCoreGroupsCoverEveryWireField(t *testing.T) {
	var core DBCore
	b, err := json.Marshal(&core)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	// Zero value: only the non-omitempty keys appear. They are exactly today's.
	want := map[string]bool{"fetched_at": true, "total_art": true, "next_pid": true, "pack_off": true, "feeds": true}
	for k := range m {
		if !want[k] {
			t.Errorf("db.gz zero value carries unexpected key %q", k)
		}
		delete(want, k)
	}
	for k := range want {
		t.Errorf("db.gz zero value lost key %q — a deployed reader expects it", k)
	}
}
