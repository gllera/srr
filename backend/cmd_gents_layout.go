package main

import (
	"fmt"
	"strings"
)

// The binary-layout emitters behind `srr gen-ts` (see idx_layout.go for WHY).
// One declaration in, two parsers out: Go encode+decode into
// backend/idx_layout.gen.go, TS decode into the binary-layout section of
// frontend/src/js/format.gen.ts.
//
// The emitters deliberately understand ONE shape — the shape every pack series
// in this store actually has: a header of fixed scalars followed by arrays
// counted by one of those scalars, a repeated entry whose count is chron
// arithmetic the bytes do not carry, and a trailing field that consumes the
// rest. Anything else is a hard error at generate time rather than a silently
// wrong parser; widen the emitters when a real second shape arrives.

// layoutPlan is a validated binLayout with its byte offsets resolved.
type layoutPlan struct {
	l binLayout
	// pfx is the identifier prefix every emitted name carries ("idx").
	pfx string
	// scalars are the header's countOne fields, in wire order; scalarOff maps
	// each Name to its byte offset from the start of the header.
	scalars   []binField
	scalarOff map[string]int
	// vars are the header's countField arrays, in wire order.
	vars []binField
	// prefix is the byte length of the scalar run — the fixed part a reader can
	// always read before it knows how long the header is.
	prefix int
	// geo are the scalars the header geometry depends on (each vars entry's
	// From, deduped, in first-use order). They become the parameters of the
	// generated geometry functions.
	geo []binField
}

// planLayout validates a declaration and resolves its offsets.
func planLayout(l binLayout) (*layoutPlan, error) {
	p := &layoutPlan{l: l, pfx: binLowerFirst(l.Name), scalarOff: map[string]int{}}
	if l.Name == "" || strings.ToUpper(l.Name[:1]) != l.Name[:1] {
		return nil, fmt.Errorf("layout name %q must be exported-cased", l.Name)
	}
	seenVar := false
	for _, f := range l.Header {
		if err := binCheckWidth(l.Name, f); err != nil {
			return nil, err
		}
		switch f.Count {
		case countOne:
			if seenVar {
				// Offsets past a variable-length field are not constants, and a
				// reader that must parse to find a scalar cannot peek it.
				return nil, fmt.Errorf("%s.%s: a scalar may not follow a variable-length header field", l.Name, f.Name)
			}
			p.scalarOff[f.Name] = p.prefix
			p.prefix += f.Width
			p.scalars = append(p.scalars, f)
		case countField:
			seenVar = true
			src, ok := binFind(p.scalars, f.From)
			if !ok {
				return nil, fmt.Errorf("%s.%s: count field %q is not an earlier scalar", l.Name, f.Name, f.From)
			}
			if binGoElem(src) != "int" {
				return nil, fmt.Errorf("%s.%s: count field %q must decode as int", l.Name, f.Name, f.From)
			}
			if _, dup := binFind(p.geo, f.From); !dup {
				p.geo = append(p.geo, src)
			}
			p.vars = append(p.vars, f)
		default:
			return nil, fmt.Errorf("%s.%s: header fields take countOne or countField", l.Name, f.Name)
		}
	}
	if err := binCheckWidth(l.Name, l.Entry); err != nil {
		return nil, err
	}
	if l.Entry.Count != countArg || l.Entry.From == "" {
		return nil, fmt.Errorf("%s.%s: the entry field must be countArg with a named argument", l.Name, l.Entry.Name)
	}
	if err := binCheckWidth(l.Name, l.Footer); err != nil {
		return nil, err
	}
	if l.Footer.Count != countRest {
		return nil, fmt.Errorf("%s.%s: the footer field must be countRest", l.Name, l.Footer.Name)
	}
	return p, nil
}

func binCheckWidth(layout string, f binField) error {
	switch f.Width {
	case 2, 4, 8:
	default:
		return fmt.Errorf("%s.%s: unsupported element width %d (want 2, 4 or 8)", layout, f.Name, f.Width)
	}
	if f.Endian != binLE {
		return fmt.Errorf("%s.%s: unsupported byte order %q", layout, f.Name, f.Endian)
	}
	if f.Name == "" || f.TS == "" {
		return fmt.Errorf("%s: a field needs both a Go and a TS name", layout)
	}
	return nil
}

func binFind(fs []binField, name string) (binField, bool) {
	for _, f := range fs {
		if f.Name == name {
			return f, true
		}
	}
	return binField{}, false
}

func binLowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// binWire is the unsigned integer type the wire carries for a width.
func binWire(f binField) string { return fmt.Sprintf("uint%d", f.Width*8) }

// binGoElem is the Go type the decoded field takes: the declared override, else
// the wire type.
func binGoElem(f binField) string {
	if f.GoElem != "" {
		return f.GoElem
	}
	return binWire(f)
}

// binOrder is the encoding/binary byte-order value for a field.
func binOrder(binField) string { return "binary.LittleEndian" }

// binVerb is the encoding/binary method suffix for a width ("Uint32").
func binVerb(f binField) string { return "Uint" + fmt.Sprint(f.Width*8) }

// binConvIn wraps a wire read in a conversion when the Go element type is wider.
func binConvIn(f binField, expr string) string {
	if binGoElem(f) == binWire(f) {
		return expr
	}
	return fmt.Sprintf("%s(%s)", binGoElem(f), expr)
}

// binConvOut wraps a Go value in a conversion back down to the wire type.
func binConvOut(f binField, expr string) string {
	if binGoElem(f) == binWire(f) {
		return expr
	}
	return fmt.Sprintf("%s(%s)", binWire(f), expr)
}

// binGeoParams renders the geometry parameter list ("numSlots int, packSize int").
func (p *layoutPlan) binGeoParams(extra ...binField) string {
	var out []string
	for _, f := range p.geo {
		out = append(out, binLowerFirst(f.Name)+" int")
	}
	for _, f := range extra {
		out = append(out, f.From+" int")
	}
	return strings.Join(out, ", ")
}

// binGeoArgs renders the matching argument list ("numSlots, packSize").
func (p *layoutPlan) binGeoArgs(extra ...binField) string {
	var out []string
	for _, f := range p.geo {
		out = append(out, binLowerFirst(f.Name))
	}
	for _, f := range extra {
		out = append(out, f.From)
	}
	return strings.Join(out, ", ")
}

// binHeaderEndExpr is the header-length expression ("12 + numSlots*4").
func (p *layoutPlan) binHeaderEndExpr(mul string) string {
	out := fmt.Sprint(p.prefix)
	for _, f := range p.vars {
		out += fmt.Sprintf(" + %s%s%d", binLowerFirst(f.From), mul, f.Width)
	}
	return out
}

// emitGoLayout writes one layout's Go encoder/decoder.
func emitGoLayout(b *strings.Builder, p *layoutPlan) {
	x, l := p.pfx, p.l
	entry, footer := l.Entry, l.Footer

	fmt.Fprintf(b, "\n// %s — %s.\n", l.Name, l.Doc)

	fmt.Fprintf(b, "\n// %sHeaderEnd is the byte offset at which the header ends and the entry\n"+
		"// array begins.\nfunc %sHeaderEnd(%s) int {\n\treturn %s\n}\n",
		x, x, p.binGeoParams(), p.binHeaderEndExpr("*"))

	fmt.Fprintf(b, "\n// %sEntriesEnd is the byte offset at which the entry array ends and the\n"+
		"// footer begins.\nfunc %sEntriesEnd(%s) int {\n\treturn %sHeaderEnd(%s) + %s*%d\n}\n",
		x, x, p.binGeoParams(entry), x, p.binGeoArgs(), entry.From, entry.Width)

	for _, f := range p.geo {
		fmt.Fprintf(b, "\n// %s%s reads the %s scalar out of a header prefix: %s.\n"+
			"func %s%s(buf []byte) (int, error) {\n"+
			"\tif len(buf) < %d {\n\t\treturn 0, fmt.Errorf(\"short header: %%d < %%d\", len(buf), %d)\n\t}\n"+
			"\treturn %s, nil\n}\n",
			x, f.Name, f.TS, f.Doc, x, f.Name, p.prefix, p.prefix,
			binConvIn(f, fmt.Sprintf("%s.%s(buf[%d:])", binOrder(f), binVerb(f), p.scalarOff[f.Name])))
	}

	fmt.Fprintf(b, "\n// %sHeaderSpan is the byte length of the variable-length header starting at\n"+
		"// buf[0] — how far a walk over concatenated headers advances to reach the\n"+
		"// next one. It errors when buf holds neither the prefix nor the counts the\n"+
		"// prefix declares.\nfunc %sHeaderSpan(buf []byte) (int, error) {\n", x, x)
	for _, f := range p.geo {
		fmt.Fprintf(b, "\t%s, err := %s%s(buf)\n\tif err != nil {\n\t\treturn 0, err\n\t}\n",
			binLowerFirst(f.Name), x, f.Name)
	}
	fmt.Fprintf(b, "\tend := %sHeaderEnd(%s)\n"+
		"\tif len(buf) < end {\n"+
		"\t\treturn 0, fmt.Errorf(\"short header: %%d < %%d (prefix plus the declared counts)\", len(buf), end)\n"+
		"\t}\n\treturn end, nil\n}\n", x, p.binGeoArgs())

	fmt.Fprintf(b, "\n// %sValidate reports what is wrong with a buffer of size bytes claiming the\n"+
		"// given counts — nil when the shape is well-formed. Both readers state a\n"+
		"// corrupt pack in exactly these words.\nfunc %sValidate(size int, %s) error {\n"+
		"\tend := %sEntriesEnd(%s)\n"+
		"\tif size < end {\n"+
		"\t\treturn fmt.Errorf(\"short body: have %%d, want >= %%d (header+%%d entries)\", size, end, %s)\n\t}\n"+
		"\tif (size-end)%%%d != 0 {\n"+
		"\t\treturn fmt.Errorf(\"footer not whole u%d %s: %%d trailing bytes\", size-end)\n\t}\n"+
		"\treturn nil\n}\n",
		x, x, p.binGeoParams(entry), x, p.binGeoArgs(entry), entry.From,
		footer.Width, footer.Width*8, footer.TS)

	fmt.Fprintf(b, "\n// %sRaw is one decoded object, one member per declared field.\ntype %sRaw struct {\n", x, x)
	for _, f := range append(append([]binField{}, l.Header...), entry, footer) {
		if f.Count == countOne {
			fmt.Fprintf(b, "\t%s %s // %s\n", f.Name, binGoElem(f), f.Doc)
		} else {
			fmt.Fprintf(b, "\t%s []%s // %s\n", f.Name, binGoElem(f), f.Doc)
		}
	}
	b.WriteString("}\n")

	fmt.Fprintf(b, "\n// %sDecode decodes buf as one object holding %s entries.\n"+
		"func %sDecode(buf []byte, %s int) (%sRaw, error) {\n\tvar raw %sRaw\n",
		x, entry.From, x, entry.From, x, x)
	for _, f := range p.geo {
		fmt.Fprintf(b, "\t%s, err := %s%s(buf)\n\tif err != nil {\n\t\treturn raw, err\n\t}\n",
			binLowerFirst(f.Name), x, f.Name)
	}
	fmt.Fprintf(b, "\tif err := %sValidate(len(buf), %s); err != nil {\n\t\treturn raw, err\n\t}\n",
		x, p.binGeoArgs(entry))
	for _, f := range p.scalars {
		fmt.Fprintf(b, "\traw.%s = %s\n", f.Name,
			binConvIn(f, fmt.Sprintf("%s.%s(buf[%d:])", binOrder(f), binVerb(f), p.scalarOff[f.Name])))
	}
	for _, f := range p.vars {
		fmt.Fprintf(b, "\traw.%s = make([]%s, %s)\n\tfor i := range raw.%s {\n\t\traw.%s[i] = %s\n\t}\n",
			f.Name, binGoElem(f), binLowerFirst(f.From), f.Name, f.Name,
			binConvIn(f, fmt.Sprintf("%s.%s(buf[%d+i*%d:])", binOrder(f), binVerb(f), p.prefix, f.Width)))
	}
	fmt.Fprintf(b, "\toff := %sHeaderEnd(%s)\n\traw.%s = make([]%s, %s)\n"+
		"\tfor i := range raw.%s {\n\t\traw.%s[i] = %s\n\t}\n",
		x, p.binGeoArgs(), entry.Name, binGoElem(entry), entry.From, entry.Name, entry.Name,
		binConvIn(entry, fmt.Sprintf("%s.%s(buf[off+i*%d:])", binOrder(entry), binVerb(entry), entry.Width)))
	fmt.Fprintf(b, "\traw.%s = %sDecodeFooter(buf[%sEntriesEnd(%s):])\n\treturn raw, nil\n}\n",
		footer.Name, x, x, p.binGeoArgs(entry))

	fmt.Fprintf(b, "\n// %sDecodeFooter decodes a standalone footer — the bytes after the entry\n"+
		"// array, whose element count is implicit in their length.\n"+
		"func %sDecodeFooter(footer []byte) []%s {\n"+
		"\tout := make([]%s, len(footer)/%d)\n\tfor i := range out {\n\t\tout[i] = %s\n\t}\n\treturn out\n}\n",
		x, x, binGoElem(footer), binGoElem(footer), footer.Width,
		binConvIn(footer, fmt.Sprintf("%s.%s(footer[i*%d:])", binOrder(footer), binVerb(footer), footer.Width)))

	// Encoders. A scalar that another field's count comes from is NOT a
	// parameter: it is len(that field), so an encoder cannot state a count the
	// bytes contradict.
	var params []string
	for _, f := range p.scalars {
		if _, isCount := binFind(p.geo, f.Name); !isCount {
			params = append(params, binLowerFirst(f.Name)+" "+binGoElem(f))
		}
	}
	for _, f := range p.vars {
		params = append(params, binLowerFirst(f.Name)+" []"+binGoElem(f))
	}
	fmt.Fprintf(b, "\n// %sAppendHeader appends the variable-length header to dst. Every count is\n"+
		"// derived from the slice it counts, so a header can never claim a length its\n"+
		"// own bytes contradict.\nfunc %sAppendHeader(dst []byte, %s) []byte {\n",
		x, x, strings.Join(params, ", "))
	for _, f := range p.scalars {
		val := binLowerFirst(f.Name)
		if _, isCount := binFind(p.geo, f.Name); isCount {
			for _, v := range p.vars {
				if v.From == f.Name {
					val = fmt.Sprintf("len(%s)", binLowerFirst(v.Name))
					break
				}
			}
		}
		fmt.Fprintf(b, "\tdst = %s.Append%s(dst, %s)\n", binOrder(f), binVerb(f), binConvOut(f, val))
	}
	for _, f := range p.vars {
		fmt.Fprintf(b, "\tfor _, v := range %s {\n\t\tdst = %s.Append%s(dst, %s)\n\t}\n",
			binLowerFirst(f.Name), binOrder(f), binVerb(f), binConvOut(f, "v"))
	}
	b.WriteString("\treturn dst\n}\n")

	fmt.Fprintf(b, "\n// %sAppendEntry appends one entry to dst.\nfunc %sAppendEntry(dst []byte, %s %s) []byte {\n"+
		"\treturn %s.Append%s(dst, %s)\n}\n",
		x, x, entry.One, binGoElem(entry), binOrder(entry), binVerb(entry), binConvOut(entry, entry.One))

	fmt.Fprintf(b, "\n// %sAppendFooter appends the whole footer to dst.\n"+
		"func %sAppendFooter(dst []byte, %s []%s) []byte {\n"+
		"\tfor _, v := range %s {\n\t\tdst = %s.Append%s(dst, %s)\n\t}\n\treturn dst\n}\n",
		x, x, binLowerFirst(footer.Name), binGoElem(footer), binLowerFirst(footer.Name),
		binOrder(footer), binVerb(footer), binConvOut(footer, "v"))
}

// tsReadExpr renders a little-endian element read. Width 2 is assembled from
// the byte view by hand — the entry scan runs it up to IDX_PACK_SIZE times per
// pack, and that loop is the reader's hottest — while wider elements go through
// a DataView, which is alignment-free and states its byte order explicitly.
func tsReadExpr(f binField, bytes, view, off string) string {
	if f.Width == 2 {
		return fmt.Sprintf("%s[%s] | (%s[%s + 1] << 8)", bytes, off, bytes, off)
	}
	return fmt.Sprintf("%s.get%s(%s, true)", view, binVerb(f), off)
}

// tsArray is the typed-array constructor for a width.
func tsArray(f binField) string { return fmt.Sprintf("Uint%dArray", f.Width*8) }

func (p *layoutPlan) tsGeoParams(extra ...binField) string {
	var out []string
	for _, f := range p.geo {
		out = append(out, f.TS+": number")
	}
	for _, f := range extra {
		out = append(out, f.From+": number")
	}
	return strings.Join(out, ", ")
}

func (p *layoutPlan) tsGeoArgs(extra ...binField) string {
	var out []string
	for _, f := range p.geo {
		out = append(out, f.TS)
	}
	for _, f := range extra {
		out = append(out, f.From)
	}
	return strings.Join(out, ", ")
}

// tsHeaderEndExpr is the header-length expression in TS spacing.
func (p *layoutPlan) tsHeaderEndExpr() string {
	out := fmt.Sprint(p.prefix)
	for _, f := range p.vars {
		src, _ := binFind(p.scalars, f.From)
		out += fmt.Sprintf(" + %s * %d", src.TS, f.Width)
	}
	return out
}

// emitTSLayout writes one layout's TypeScript decoder. The reader never WRITES
// a pack, so no encoder is emitted — the asymmetry is the contract's, not an
// omission.
func emitTSLayout(b *strings.Builder, p *layoutPlan) {
	x, l := p.pfx, p.l
	entry, footer := l.Entry, l.Footer

	fmt.Fprintf(b, "\n// %s — %s.\n", l.Name, l.Doc)

	fmt.Fprintf(b, "\n// The decoded header of one %s object.\nexport interface I%sHeader {\n", l.Name, l.Name)
	for _, f := range l.Header {
		if f.Count == countOne {
			fmt.Fprintf(b, "   %s: number // %s\n", f.TS, f.Doc)
		} else {
			fmt.Fprintf(b, "   %s: %s // %s\n", f.TS, tsArray(f), f.Doc)
		}
	}
	b.WriteString("}\n")

	fmt.Fprintf(b, "\n// Byte offset at which the header ends and the entry array begins.\n"+
		"export function %sHeaderEnd(%s): number {\n   return %s\n}\n",
		x, p.tsGeoParams(), p.tsHeaderEndExpr())

	fmt.Fprintf(b, "\n// Byte offset at which the entry array ends and the footer begins.\n"+
		"export function %sEntriesEnd(%s): number {\n   return %sHeaderEnd(%s) + %s * %d\n}\n",
		x, p.tsGeoParams(entry), x, p.tsGeoArgs(), entry.From, entry.Width)

	fmt.Fprintf(b, "\n// What is wrong with a buffer of size bytes claiming the given counts —\n"+
		"// null when the shape is well-formed. The Go reader states it identically.\n"+
		"export function %sValidate(size: number, %s): string | null {\n"+
		"   const end = %sEntriesEnd(%s)\n"+
		"   if (size < end) return `short body: have ${size}, want >= ${end} (header+${%s} entries)`\n"+
		"   if ((size - end) %% %d !== 0) return `footer not whole u%d %s: ${size - end} trailing bytes`\n"+
		"   return null\n}\n",
		x, p.tsGeoParams(entry), x, p.tsGeoArgs(entry), entry.From,
		footer.Width, footer.Width*8, footer.TS)

	fmt.Fprintf(b, "\n// Decodes the header at byteOff. Counts are copied out, so the source\n"+
		"// buffer can be released independently.\n"+
		"export function %sDecodeHeader(buf: ArrayBuffer, byteOff: number): I%sHeader {\n"+
		"   const v = new DataView(buf, byteOff)\n", x, l.Name)
	for _, f := range p.scalars {
		fmt.Fprintf(b, "   const %s = %s\n", f.TS, tsReadExpr(f, "", "v", fmt.Sprint(p.scalarOff[f.Name])))
	}
	for _, f := range p.vars {
		src, _ := binFind(p.scalars, f.From)
		fmt.Fprintf(b, "   const %s = new %s(%s)\n"+
			"   for (let i = 0; i < %s; i++) %s[i] = %s\n",
			f.TS, tsArray(f), src.TS, src.TS, f.TS,
			tsReadExpr(f, "", "v", fmt.Sprintf("%d + i * %d", p.prefix, f.Width)))
	}
	var members []string
	for _, f := range l.Header {
		members = append(members, f.TS)
	}
	fmt.Fprintf(b, "   return { %s }\n}\n", strings.Join(members, ", "))

	fmt.Fprintf(b, "\n// Decodes exactly %s entries — never more, so an oversized body (a stale\n"+
		"// cache, a truncated write) cannot push ghost rows into the caller's tallies.\n"+
		"export function %sDecodeEntries(buf: ArrayBuffer, %s): %s {\n"+
		"   const bytes = new Uint8Array(buf)\n   const out = new %s(%s)\n"+
		"   let off = %sHeaderEnd(%s)\n"+
		"   for (let i = 0; i < %s; i++) {\n      out[i] = %s\n      off += %d\n   }\n   return out\n}\n",
		entry.From, x, p.tsGeoParams(entry), tsArray(entry), tsArray(entry), entry.From,
		x, p.tsGeoArgs(), entry.From, tsReadExpr(entry, "bytes", "", "off"), entry.Width)

	fmt.Fprintf(b, "\n// Decodes the footer: every byte after the entry array, whose element\n"+
		"// count is implicit in their length.\n"+
		"export function %sDecodeFooter(buf: ArrayBuffer, %s): %s {\n"+
		"   const bytes = new Uint8Array(buf)\n"+
		"   const start = %sEntriesEnd(%s)\n"+
		"   const out = new %s(Math.max(0, Math.floor((bytes.length - start) / %d)))\n"+
		"   for (let i = 0; i < out.length; i++) {\n      const off = start + i * %d\n      out[i] = %s\n   }\n"+
		"   return out\n}\n",
		x, p.tsGeoParams(entry), tsArray(footer), x, p.tsGeoArgs(entry),
		tsArray(footer), footer.Width, footer.Width, tsReadExpr(footer, "bytes", "", "off"))
}
