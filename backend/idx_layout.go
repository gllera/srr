package main

// The BINARY LAYOUT DECLARATIONS — the writer↔reader contract's byte-level
// half, stated once.
//
// The JSON half of the contract has had a single source since gen-ts existed:
// the Go struct tags, reflected into frontend/src/js/format.gen.ts. The BINARY
// half did not. Its atoms (idxHeaderPrefix, idxEntrySize, idxBoundarySize, …)
// were generated, but the arithmetic that turns those atoms into offsets — and
// the loops that read and write them — were hand-implemented THREE times: the
// writer (db_pack.go writeIdxHeader/writeIdx/writeIdxFooter), the Go reader
// (idx_read.go parseIdxPack) and the TS reader (frontend/src/js/idx.ts). Three
// hand-written mirrors of one layout is three places a width, an offset or a
// byte order can drift, and a drift there is not a compile error — it is a
// store that addresses the wrong article.
//
// So the layout itself is declared here, and cmd_gents.go emits BOTH sides from
// it: backend/idx_layout.gen.go (Go encode + decode) and the binary-layout
// section of frontend/src/js/format.gen.ts (TS decode). All three call sites
// consume generated code; `make generate-check` (inside `make verify-be`) fails
// when either output is stale.
//
// What stays hand-written is everything ABOVE the bytes: bounds reconstruction,
// the ownFeedCounts tally, the header-count shortcut, the bounds guards that
// answer `feedCounts[id >= numSlots]` as 0. Those are semantics, not layout.

// binEndian is a field's byte order. Declared rather than assumed: the idx
// format is little-endian throughout, and a future series that is not must not
// be able to inherit that silently.
type binEndian string

const binLE binEndian = "le"

// binCount says where a field's ELEMENT COUNT comes from — the one thing a
// fixed-width layout cannot state as a number.
type binCount int

const (
	// countOne is a scalar: exactly one element.
	countOne binCount = iota
	// countField takes its count from an earlier scalar field of the same
	// header (binField.From names it). This is what makes the idx header
	// variable-length.
	countField
	// countArg takes its count from a parse-time argument the caller supplies
	// (binField.From names it) — for idx, the pack's entry count, which is
	// chron arithmetic the bytes do not carry.
	countArg
	// countRest consumes whatever bytes remain. Legal only for the trailing
	// field, which is exactly how the idx boundary footer states its length.
	countRest
)

// binField is one region of a binary layout: Count elements of a Width-byte
// integer in Endian order.
type binField struct {
	// Name is the Go identifier: the exported member of the generated decode
	// struct, and the parameter name in the generated encoders.
	Name string
	// TS is the member name on the generated TypeScript side.
	TS string
	// One is the singular parameter name for a per-element encoder (the entry
	// field only).
	One string
	// Width is the bytes per element (1, 2, 4 or 8).
	Width  int
	Endian binEndian
	Count  binCount
	// From names the count source: the scalar field for countField, the
	// parse-time argument for countArg.
	From string
	// GoElem overrides the Go element type. Empty derives it from Width
	// (uint8/uint16/uint32/uint64). Set it where the consumers want a wider
	// type than the wire carries — the widening is then declared here rather
	// than open-coded at each call site.
	GoElem string
	Doc    string
}

// binLayout is one binary object's layout, in the vocabulary the format
// documents itself in (docs: "header ‖ entries ‖ footer"). The three groups are
// separate because the WRITER emits them separately: the header once per pack,
// an entry per article, the footer once at finalize.
type binLayout struct {
	// Name prefixes every generated identifier (Go: idx…; TS: idx…/IIdx…).
	Name   string
	Doc    string
	Header []binField
	Entry  binField
	Footer binField
}

// idxLayout declares the binary idx pack format. The widths reference the
// exported format atoms in db.go, so the constants the reader imports and the
// code both sides run are the same declaration — and TestIdxLayoutGeometry
// pins the derived offsets against those atoms.
var idxLayout = binLayout{
	Name: "Idx",
	Doc:  "one idx pack — variable-length header ‖ 2-byte entries ‖ boundary footer, little-endian throughout",
	Header: []binField{
		{
			Name: "PackIDBase", TS: "packIdBase", Width: 4, Endian: binLE, Count: countOne,
			Doc: "the data packId the pack's first entry lives in",
		},
		{
			Name: "PackOffBase", TS: "packOffBase", Width: 4, Endian: binLE, Count: countOne,
			Doc: "that entry's offset inside the data pack",
		},
		{
			Name: "NumSlots", TS: "numSlots", Width: 4, Endian: binLE, Count: countOne, GoElem: "int",
			Doc: "how many cumulative per-feed counts follow — dense up to the high-water feed id when the pack was written",
		},
		{
			Name: "FeedCounts", TS: "feedCounts", Width: 4, Endian: binLE, Count: countField, From: "NumSlots",
			Doc: "cumulative articles per feed BEFORE this pack, as of its first chron",
		},
	},
	Entry: binField{
		Name: "FeedIDs", TS: "feedIds", One: "feedID", Width: idxEntrySize, Endian: binLE,
		Count: countArg, From: "packSize",
		Doc: "one feed_id per article, in chron order",
	},
	Footer: binField{
		Name: "Boundaries", TS: "boundaries", One: "boundary", Width: idxBoundarySize, Endian: binLE,
		Count: countRest, GoElem: "int",
		Doc: "ascending local entry indices at which the data packId advances by 1",
	},
}

// binLayouts is every layout gen-ts emits, in emission order.
var binLayouts = []binLayout{idxLayout}
