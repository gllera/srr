package mod

import (
	"context"
	"strings"

	"golang.org/x/net/html"
)

// The one-parse content session.
//
// Every HTML-walking step used to own a full parse/render round-trip of the
// item's content: #enclosure, #unlazy, #untrack, #dedupmedia, #embed,
// #selfhost, the language stamp and the URL absolutizer each turned the string
// into a DOM, walked it, and serialized it back. A rich pipe therefore parsed
// and re-rendered one article eight to eleven times — pure CPU on the box the
// fetch loop runs on, and every extra round-trip is another chance for the
// serializer to perturb content that nothing asked to change (which is why
// each of those steps carefully returns its input VERBATIM on a no-op).
//
// A Session is that round-trip, hoisted to the item: it parses once, hands the
// same *html.Node to every DOM-capable step in a contiguous run, and
// materializes a string only at a boundary — a step that works on the string
// form (#sanitize, #minify, #readability, an external shell mod), or the end
// of the pipeline. The verbatim-on-no-op contract survives unchanged: the DOM
// is rendered back only when some step actually reported a change.
//
// DOMProcessor is the step type that opts in; a plain Processor still works
// and simply forces the materialization it always implied.

// DOMProcessor is a built-in pipeline step that reads and mutates the item's
// content as a parsed DOM instead of a string. body is the synthetic <body>
// whose children are the content fragment (the shape parseBodyHTML builds).
// Returning changed=true marks the session dirty, so the DOM is rendered back
// into RawItem.Content at the next string boundary; returning false leaves the
// content string untouched, byte for byte.
//
// A step still receives the item — for the fields that are NOT content (Raw,
// Link, Lang) — but must neither read nor write i.Content: the session owns
// it, so the string is STALE for as long as an earlier DOM step's changes are
// unrendered, and a write would be discarded by the next flush. The body is
// the content.
type DOMProcessor func(ctx context.Context, p Params, i *RawItem, body *html.Node) (changed bool, err error)

var domRegistry = map[string]func() DOMProcessor{}

// RegisterDOM registers a DOM-capable built-in available as "#name", the
// Session-aware sibling of Register. The init factory runs once per New(), so
// a built-in can capture per-instance state exactly as a string step can.
func RegisterDOM(name string, init func() DOMProcessor) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	domRegistry[name] = init
}

// builtinStep is a resolved built-in pipeline token: exactly one of str/dom is
// non-nil, plus the parameters parsed off the token.
type builtinStep struct {
	name   string
	str    Processor
	dom    DOMProcessor
	params Params
}

// resolveStep resolves a pipeline token to its built-in step. ok=false means
// the token names no built-in and belongs to the shell path — that includes a
// shell command whose first word merely contains spaces or "=", which is why
// the params are only parsed once a built-in name matched. An error is a
// parameter error (bad value, unknown key) and is always a hard one; ok is
// true then, so the caller can attribute it to the step by name.
func (o *Module) resolveStep(args string) (builtinStep, bool, error) {
	trimmed := strings.TrimSpace(args)
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return builtinStep{}, false, nil
	}
	st := builtinStep{name: fields[0], str: o.processors[fields[0]], dom: o.domProcessors[fields[0]]}
	if st.str == nil && st.dom == nil {
		return builtinStep{}, false, nil
	}
	pfields, err := splitParamFields(trimmed[len(st.name):])
	if err != nil {
		return st, true, err
	}
	if st.params, err = parseParams(pfields); err != nil {
		return st, true, err
	}
	return st, true, nil
}

// Session is one item's content session: the parsed form of RawItem.Content,
// shared across a run of DOM steps and materialized back into the string only
// at a boundary. Not safe for concurrent use — one item, one goroutine, like
// the *Module it comes from.
type Session struct {
	m *Module
	i *RawItem

	// body is the parse of src; parsed records that the attempt was made (body
	// stays nil when the fragment does not parse, and a second DOM() for the
	// same string must not retry it). dirty means some step reported a change
	// that has not been rendered back yet.
	body   *html.Node
	src    string
	parsed bool
	dirty  bool

	// rev counts content mutations — DOM changes and string steps that
	// rewrote Content alike. Callers use it to answer "did anything touch the
	// content?" without holding (and therefore materializing) a before-image.
	rev int
}

// NewSession starts a content session for one item. The item's content is not
// parsed until a DOM step (or DOM()) asks for it, so a string-only pipeline
// costs nothing.
func (o *Module) NewSession(i *RawItem) *Session {
	return &Session{m: o, i: i}
}

// DOM returns the item's content as a parsed body node, parsing on first use
// and re-parsing whenever the content string changed underneath (a string step
// or an external mod rewrote it). It returns nil when the fragment does not
// parse — every caller treats that as "pass the content through untouched".
func (s *Session) DOM() *html.Node {
	if s.parsed && s.src == s.i.Content {
		return s.body
	}
	s.body = parseBodyHTML(s.i.Content)
	s.src = s.i.Content
	s.parsed = true
	s.dirty = false
	return s.body
}

// Changed marks the DOM mutated, so the next Flush renders it back into
// RawItem.Content. A step that changed nothing must not call it: that is what
// keeps a no-op pass byte-identical.
func (s *Session) Changed() {
	s.dirty = true
	s.rev++
}

// Rev is the content mutation counter (see Session.rev). Compare two readings
// to learn whether anything rewrote the content in between.
func (s *Session) Rev() int { return s.rev }

// Flush materializes a dirty DOM back into RawItem.Content. It is the boundary
// every string-form reader must cross first, and it is idempotent.
//
// A render failure keeps the last materialized string (the same fail-safe each
// step used to apply on its own) and DROPS the DOM, so the next step re-parses
// from the content that is actually stored rather than re-rendering a body
// that already proved unrenderable. html.Render only fails on a malformed node
// tree, which the parser cannot produce — the cost of the accumulated changes
// being discarded together is accepted for that.
func (s *Session) Flush() {
	if !s.dirty {
		return
	}
	s.dirty = false
	if s.body == nil {
		return
	}
	out, ok := renderBodyHTML(s.body)
	if !ok {
		s.body, s.parsed = nil, false
		return
	}
	s.i.Content = out
	s.src = out
}

// Close ends the session, materializing any pending DOM changes. Callers
// defer it; it is idempotent, so an explicit Close before reading the content
// string is the normal way to end a pipeline.
func (s *Session) Close() { s.Flush() }

// Process runs one pipeline token against the session's item. A DOM-capable
// built-in runs on the shared parse; anything else (a string built-in, a shell
// command) first materializes the DOM, since it reads RawItem.Content.
func (s *Session) Process(ctx context.Context, args string) error {
	st, ok, err := s.m.resolveStep(args)
	if err != nil {
		return err
	}
	if ok && st.dom != nil {
		body := s.DOM()
		if body == nil {
			// Unparseable content: the DOM steps' shared fail-open — leave the
			// item exactly as it is rather than failing it.
			return nil
		}
		changed, err := st.dom(ctx, st.params, s.i, body)
		if changed {
			s.Changed()
		}
		return err
	}

	s.Flush()
	before := s.i.Content
	if ok {
		err = st.str(ctx, st.params, s.i)
	} else {
		err = s.m.runExternal(ctx, args, s.i)
	}
	if s.i.Content != before {
		s.rev++
	}
	return err
}
