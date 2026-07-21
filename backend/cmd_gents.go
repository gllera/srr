package main

import (
	"bytes"
	"fmt"
	"os"
	"reflect"
	"strings"

	"srr/store"
)

//go:generate go run . gen-ts

// GenTSCmd emits the TypeScript side of the writer↔reader data contract
// (frontend/src/js/format.gen.ts): the idx format constants, the write-once
// pack-name grammar (store.PackSeries), and the wire shapes of the JSON the
// backend writes (db.gz, JSONL data packs), reflected from the live Go
// declarations so every format atom has exactly one source. Hidden dev tooling: run via `make generate`
// (`go generate ./...`); `make verify` runs `--check` so a stale file
// fails loudly.
type GenTSCmd struct {
	Out   string `default:"../frontend/src/js/format.gen.ts" help:"Output path (default is relative to backend/)."`
	Check bool   `help:"Verify the output file matches what would be generated; non-zero exit on drift."`
}

// tsConsts maps the Go format constants to their exported TS names. The
// values are referenced, not copied — changing a Go const regenerates a
// changed TS file.
var tsConsts = []struct {
	name  string
	value int
	doc   string
}{
	{"DB_FORMAT_VERSION", dbFormatVersion, "store format version this build understands — the `v` of the root db.gz AND of every manifest it names; a store stamped higher was written by a newer srr and this reader cannot be trusted with it"},
	{"IDX_PACK_SIZE", idxPackSize, "entries per finalized idx pack (split threshold)"},
	{"META_PACK_SIZE", metaPackSize, "entries per finalized meta shard (the meta/ split stride; a divisor of IDX_PACK_SIZE)"},
	{"HEAD_MAX", headMax, "cap on the newest-glance head projection in db.gz (db.head: the newest cards, chron order)"},
	{"IDX_STATE_SIZE", idxStateSize, "bytes: the 2 leading uint32 LE idx-header state fields (packId/packOff bases)"},
	{"IDX_HEADER_PREFIX", idxHeaderPrefix, "bytes: idx-header fixed prefix (2 state uint32s + numSlots uint32); the variable count array follows"},
	{"IDX_ENTRY_SIZE", idxEntrySize, "bytes per idx entry: feed_id uint16 LE (pack boundaries live in the footer)"},
	{"IDX_BOUNDARY_SIZE", idxBoundarySize, "bytes per idx footer boundary: a uint16 LE local entry index where the data packId advances"},
	{"FEED_ID_CEILING", feedIDCeiling, "feed-id ceiling: feed_id is a uint16, ids run [0, this)"},
	{"KEEP_MANIFESTS", keepManifests, "default GC grace window K: generation manifests the backend keeps alongside the current one, and with them every object they name (docs/MANIFEST-SPEC.md §7)"},
	{"SEARCH_GRAM", searchGram, "rune length of the sliding windows the search blooms index, per folded word"},
	{"SEARCH_BLOOM_BYTES", searchBloomBytes, "bytes: fixed-size trigram bloom heading each finalized meta shard (and per shard in meta/s<N>.gz)"},
	{"SEARCH_BLOOM_K", searchBloomK, "bloom bits set/tested per gram"},
}

// tsTypes lists the Go structs whose JSON encodings the frontend reads,
// in emission order. Nested struct fields resolve through this same
// table, so a struct reachable from here must also be listed.
//
// The manifest wire types are here rather than hand-mirrored in names.ts: the
// manifest IS the reader's boot object now, so it belongs to the single-source
// contract like every other wire shape.
var tsTypes = []struct {
	name string
	doc  string
	typ  reflect.Type
}{
	{"IArticleWire", "one JSONL line in data/*.gz (backend ArticleData)", reflect.TypeOf(ArticleData{})},
	{"IMetaWire", "one JSONL line in meta/*.gz (backend MetaEntry)", reflect.TypeOf(MetaEntry{})},
	{"IFeedWire", "a manifest feeds{} value — the reader-facing half of a feed (backend FeedPublic)", reflect.TypeOf(FeedPublic{})},
	{"ISeriesNamesWire", "one pack series' positional name list inside a manifest's `names` (backend seriesNamesWire): `b` base position, `r` run-length-encoded bare stems, `l` the tail's position", reflect.TypeOf(seriesNamesWire{})},
	{"IStemRefWire", "a singleton object named by series + stem (backend StemRef)", reflect.TypeOf(StemRef{})},
	{"ISummaryNameWire", "a derived summary object: series + stem + the finalized-pack count it covers (backend SummaryName)", reflect.TypeOf(SummaryName{})},
	{"IDeltaNamesWire", "the live delta chain, oldest first (backend DeltaNames)", reflect.TypeOf(DeltaNames{})},
	{"IManifestWire", "manifest/<m>.gz — the immutable generation manifest (backend Manifest)", reflect.TypeOf(Manifest{})},
	{"IDBWire", "db.gz itself — the mutable root pointer (backend RootState)", reflect.TypeOf(RootState{})},
}

// tsOpaque maps Go types the reflection walk cannot express to a hand-written
// TS type. ManifestNames carries a CUSTOM MarshalJSON that flattens its series
// map next to the singleton keys (§4.6 requires exactly that openness — nothing
// may assume there are three series), so its Go declaration does not describe
// its wire shape; the reader parses it generically through names.ts.
var tsOpaque = map[reflect.Type]string{
	reflect.TypeOf(ManifestNames{}): "Record<string, unknown>",
}

func (o *GenTSCmd) Run() error {
	out, err := generateTS()
	if err != nil {
		return err
	}
	if o.Check {
		disk, err := os.ReadFile(o.Out)
		if err != nil {
			return fmt.Errorf("read %s: %w (run `make generate`)", o.Out, err)
		}
		if !bytes.Equal(disk, out) {
			return fmt.Errorf("%s is stale relative to the Go declarations: run `make generate`", o.Out)
		}
		return nil
	}
	return os.WriteFile(o.Out, out, 0o644)
}

func generateTS() ([]byte, error) {
	var b strings.Builder
	b.WriteString(`// Code generated by srr gen-ts (backend/cmd_gents.go); DO NOT EDIT.
//
// The Go declarations in backend/ are the single source of truth for the
// writer↔reader data contract: the format constants in db.go, the pack-name
// grammar in store/main.go (PackSeries), and the JSON struct tags of
// ArticleData/MetaEntry/FeedPublic/Manifest/RootState. Regenerate with
// ` + "`make generate`; `make verify` fails when this file is stale." + `
//
// Wire-type conventions: ` + "`?`" + ` = json omitempty (key absent at the Go zero
// value); ` + "`| null`" + ` = a Go nil map/slice serialized while the key is present.
`)

	for _, c := range tsConsts {
		fmt.Fprintf(&b, "\n// %s\nexport const %s = %d\n", c.doc, c.name, c.value)
	}

	b.WriteString(`
// The write-once pack-name grammar (backend store.PackSeries): one entry per
// pack-series directory. Every stem is an OPAQUE bare digit run — the kind
// letters ("L" latest generations, "h"/"s" summaries, "d" delta segments) were
// retired at the manifest cutover, because a name is now LISTED rather than
// derived and carries no meaning of its own. sw.ts builds its route regex from
// this table, mirroring the store's strict packKeyRe.
export const PACK_SERIES_KINDS: Record<string, string> = {`)
	for i, s := range store.PackSeries {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, " %s: %q", s.Name, s.Kinds)
	}
	b.WriteString(" }\n")

	wireNames := map[reflect.Type]string{}
	for _, t := range tsTypes {
		wireNames[t.typ] = t.name
	}

	for _, t := range tsTypes {
		fmt.Fprintf(&b, "\n// Wire shape of %s.\nexport interface %s {\n", t.doc, t.name)
		if err := emitFields(&b, t.typ, t.typ, wireNames); err != nil {
			return nil, err
		}
		b.WriteString("}\n")
	}
	return []byte(b.String()), nil
}

// emitFields writes one struct's TS members, recursing through EMBEDDED
// (anonymous, untagged) struct fields the way encoding/json does — their
// exported fields are promoted into the outer object, so the wire shape is flat
// even though the Go declaration is grouped. DBCore is grouped exactly that way
// (docs/MANIFEST-SPEC.md §5.1: root / manifest / config / writer state), and the
// grouping must not leak into the contract the reader parses. `owner` is only
// used for error framing so a bad field names the type it was declared on.
func emitFields(b *strings.Builder, owner, typ reflect.Type, wireNames map[reflect.Type]string) error {
	for i := range typ.NumField() {
		f := typ.Field(i)
		if f.PkgPath != "" { // unexported: never serialized
			continue
		}
		name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
		if f.Anonymous {
			if name != "" {
				// A tagged embedded field is a NAMED object to encoding/json,
				// not a promotion. Nothing in the contract does that today, and
				// silently flattening one would emit a wrong shape.
				return fmt.Errorf("%s.%s: a json-tagged embedded field is not supported", owner.Name(), f.Name)
			}
			et := f.Type
			for et.Kind() == reflect.Pointer {
				et = et.Elem()
			}
			if et.Kind() != reflect.Struct {
				return fmt.Errorf("%s.%s: embedded non-struct fields are not supported", owner.Name(), f.Name)
			}
			if err := emitFields(b, et, et, wireNames); err != nil {
				return err
			}
			continue
		}
		if name == "-" {
			continue
		}
		if name == "" {
			name = f.Name // encoding/json falls back to the Go field name
		}
		tsT, nilable, err := tsType(f.Type, wireNames)
		if err != nil {
			return fmt.Errorf("%s.%s: %w", owner.Name(), f.Name, err)
		}
		switch {
		case strings.Contains(","+opts+",", ",omitempty,"):
			fmt.Fprintf(b, "   %s?: %s // %s\n", name, tsT, f.Name)
		case nilable:
			fmt.Fprintf(b, "   %s: %s | null // %s\n", name, tsT, f.Name)
		default:
			fmt.Fprintf(b, "   %s: %s // %s\n", name, tsT, f.Name)
		}
	}
	return nil
}

// tsType maps a Go type to its TypeScript wire type. nilable reports
// whether the Go zero value serializes as JSON null (map/slice/pointer).
func tsType(t reflect.Type, wireNames map[reflect.Type]string) (ts string, nilable bool, err error) {
	switch t.Kind() {
	case reflect.Pointer:
		ts, _, err = tsType(t.Elem(), wireNames)
		return ts, true, err
	case reflect.Slice:
		ts, _, err = tsType(t.Elem(), wireNames)
		return ts + "[]", true, err
	case reflect.Array:
		// A fixed-size Go array serializes as a JSON array. The manifest's
		// run-length encoding uses [2]int pairs, and TS's tuple type says
		// exactly that.
		ts, _, err = tsType(t.Elem(), wireNames)
		if err != nil {
			return "", false, err
		}
		parts := make([]string, t.Len())
		for i := range parts {
			parts[i] = ts
		}
		return "[" + strings.Join(parts, ", ") + "]", false, nil
	case reflect.Map:
		var key string
		switch t.Key().Kind() {
		case reflect.String:
			key = "string"
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
			reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			key = "number"
		default:
			return "", false, fmt.Errorf("unsupported map key type %s", t.Key())
		}
		ts, _, err = tsType(t.Elem(), wireNames)
		return fmt.Sprintf("Record<%s, %s>", key, ts), true, err
	case reflect.Struct:
		if ts, ok := tsOpaque[t]; ok {
			return ts, false, nil
		}
		name, ok := wireNames[t]
		if !ok {
			return "", false, fmt.Errorf("struct %s not listed in tsTypes", t)
		}
		return name, false, nil
	case reflect.String:
		return "string", false, nil
	case reflect.Bool:
		return "boolean", false, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return "number", false, nil
	default:
		return "", false, fmt.Errorf("unsupported type %s", t)
	}
}
