# `#filter keep_lang=` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop articles at ingest whose language is confidently detected as something other than an ISO 639-1 allowlist, via one new `#filter` parameter (`keep_lang=en,es`).

**Architecture:** A new condition on the existing `#filter` mod (`backend/mod/filter.go`), evaluated last. Text extraction (title + HTML-stripped content, 4 KiB cap) lives with the HTML helpers; detection is `whatlanggo` (pure Go, trigram, no models). Fail-open: only ≥24 runes of text at ≥0.8 confidence outside the keep set drops. No data-contract, frontend, or CLI-surface change.

**Tech Stack:** Go, `github.com/abadojack/whatlanggo v1.0.1`, `golang.org/x/net/html` (already a dep). Spec: `docs/superpowers/specs/2026-07-19-filter-keep-lang-design.md`.

**Repo conventions that apply:**
- Run commands from the repo root via `make` (`make test-be`, `make verify-be`), or `go test ./mod/ -run Name` from `backend/`.
- Commits: conventional style (`feat:`, `test(mod):`, `docs:`), explicit paths only — never `git add -A` (a concurrent session may be editing other files; check `git status --short` before staging).
- All fixture texts below were probe-verified against whatlanggo v1.0.1 (detected language + confidence noted inline). Do not swap them for other sentences — confidences differ.

---

### Task 1: `extractText` HTML→plain-text helper

**Files:**
- Modify: `backend/mod/helper_html.go` (append)
- Create: `backend/mod/helper_html_test.go`

- [ ] **Step 1: Write the failing tests**

Create `backend/mod/helper_html_test.go`:

```go
package mod

import (
	"strings"
	"testing"
)

// TestExtractTextStripsMarkup: tags are dropped, text nodes joined by spaces.
func TestExtractTextStripsMarkup(t *testing.T) {
	got := extractText("Title here", `<p>Hello <b>world</b></p><div>again</div>`, 4096)
	want := "Title here Hello world again"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextSkipsScriptAndStyle: script/style subtrees contribute nothing
// (#filter may run before #sanitize, so they can still be present).
func TestExtractTextSkipsScriptAndStyle(t *testing.T) {
	content := `<p>visible</p><script>var hidden = "nope";</script><style>.x{color:red}</style><p>tail</p>`
	got := extractText("", content, 4096)
	want := "visible tail"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextCollapsesWhitespace: runs of whitespace in title and content
// collapse to single spaces, edges trimmed.
func TestExtractTextCollapsesWhitespace(t *testing.T) {
	got := extractText("  a \n b ", "<p>  c\t\td  </p>", 4096)
	want := "a b c d"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextDecodesEntities: the HTML parser decodes entities, so the
// detector sees real letters (café, not caf&eacute;).
func TestExtractTextDecodesEntities(t *testing.T) {
	got := extractText("", "<p>caf&eacute;</p>", 4096)
	want := "café"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}

// TestExtractTextHonorsByteCap: collection stops once max bytes are gathered
// (the last word may overshoot by its own length — that is fine).
func TestExtractTextHonorsByteCap(t *testing.T) {
	long := strings.Repeat("word ", 100)
	got := extractText("", "<p>"+long+"</p>", 32)
	if len(got) < 32 || len(got) > 40 {
		t.Errorf("len(extractText) = %d, want 32..40", len(got))
	}
	if !strings.HasPrefix(got, "word word") {
		t.Errorf("extractText = %q, want word-prefixed", got)
	}
}

// TestExtractTextPlainTextContent: content without any tags passes through.
func TestExtractTextPlainTextContent(t *testing.T) {
	got := extractText("", "just plain words", 4096)
	want := "just plain words"
	if got != want {
		t.Errorf("extractText = %q, want %q", got, want)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run (from `backend/`): `go test ./mod/ -run TestExtractText -v`
Expected: compile error — `undefined: extractText`.

- [ ] **Step 3: Implement `extractText`**

Append to `backend/mod/helper_html.go`:

```go
// extractText returns the plain text of title + content for language
// detection: content is parsed as HTML and only its text nodes contribute
// (script/style subtrees excluded — a mod may run before #sanitize), all
// whitespace collapsed to single spaces. Collection stops once max bytes are
// gathered, bounding the per-article cost on huge content.
func extractText(title, content string, max int) string {
	var b strings.Builder
	appendWords := func(s string) bool {
		for _, f := range strings.Fields(s) {
			if b.Len() >= max {
				return false
			}
			if b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteString(f)
		}
		return b.Len() < max
	}
	if !appendWords(title) {
		return b.String()
	}
	body := parseBodyHTML(content)
	if body == nil {
		return b.String()
	}
	var walk func(*html.Node) bool
	walk = func(n *html.Node) bool {
		if n.Type == html.ElementNode && (n.DataAtom == atom.Script || n.DataAtom == atom.Style) {
			return true // skip subtree, keep walking siblings
		}
		if n.Type == html.TextNode && !appendWords(n.Data) {
			return false
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !walk(c) {
				return false
			}
		}
		return true
	}
	walk(body)
	return b.String()
}
```

No new imports needed — `strings`, `html`, and `atom` are already imported by this file.

- [ ] **Step 4: Run to verify they pass**

Run: `go test ./mod/ -run TestExtractText -v`
Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git status --short   # confirm only the two helper files changed
git add backend/mod/helper_html.go backend/mod/helper_html_test.go
git commit -m "feat(mod): extractText — HTML-stripped plain text for language detection"
```

---

### Task 2: the `keep_lang` condition

**Files:**
- Modify: `backend/mod/filter.go`
- Modify: `backend/mod/filter_test.go`
- Modify: `backend/go.mod`, `backend/go.sum` (via `go get`)

- [ ] **Step 1: Write the failing tests**

Append to `backend/mod/filter_test.go`. The fixture texts are **probe-verified
against whatlanggo v1.0.1** — detected language and confidence in the comments;
do not replace them:

```go
// Language fixtures, probe-verified against whatlanggo v1.0.1:
//   langTextEN → eng 0.714 (below the 0.8 gate — kept via the in-set check
//                on keep_lang=en,es, and via fail-open otherwise)
//   langTextES → spa 1.000
//   langTextDE → deu 1.000 (the Latin-script drop path)
//   langTextRU → rus 1.000 (distinct script)
//   langTextJA → jpn 1.000 (distinct script)
//   langTextPT → por 0.412 (Latin-script sibling — under the gate, kept)
const (
	langTextEN = "The quick brown fox jumps over the lazy dog while the morning sun rises slowly over the quiet English countryside."
	langTextES = "El rápido zorro marrón salta sobre el perro perezoso mientras el sol de la mañana se eleva lentamente sobre el tranquilo campo español."
	langTextDE = "Der schnelle braune Fuchs springt über den faulen Hund, während die Morgensonne langsam über der ruhigen deutschen Landschaft aufgeht."
	langTextRU = "Быстрая коричневая лиса перепрыгивает через ленивую собаку, пока утреннее солнце медленно поднимается над тихой русской деревней."
	langTextJA = "素早い茶色の狐が怠け者の犬を飛び越え、朝日が静かな田園風景の上にゆっくりと昇っていきます。"
	langTextPT = "A rápida raposa marrom salta sobre o cão preguiçoso enquanto o sol da manhã nasce lentamente sobre o campo português tranquilo."
)

// TestParseKeepLangs pins the happy path (case-insensitive, whitespace-
// tolerant) and the hard config errors: empty value, empty element, unknown
// code — the malformed-regex contract.
func TestParseKeepLangs(t *testing.T) {
	set, err := parseKeepLangs("EN, es")
	if err != nil {
		t.Fatalf("parseKeepLangs(\"EN, es\"): %v", err)
	}
	if len(set) != 2 || !set[whatlanggo.CodeToLang("eng")] || !set[whatlanggo.CodeToLang("spa")] {
		t.Errorf("parseKeepLangs(\"EN, es\") = %v, want {eng, spa}", set)
	}
	for _, bad := range []string{"", "xx", "en,,es", "en,xx", "english"} {
		if _, err := parseKeepLangs(bad); err == nil {
			t.Errorf("parseKeepLangs(%q): expected a hard error", bad)
		}
	}
}

// TestFilterKeepLangUnknownCodeIsHardError: the error surfaces through the
// pipeline (not just the parser) and names the ISO contract — distinguishing
// it from the p.only unknown-parameter error, which also mentions the key.
func TestFilterKeepLangUnknownCodeIsHardError(t *testing.T) {
	item := makeFilterItem("T", "c")
	err := runFilter(t, "#filter keep_lang=en,xx", item)
	if err == nil || !strings.Contains(err.Error(), "ISO 639-1") {
		t.Errorf("expected unknown-code hard error mentioning ISO 639-1, got: %v", err)
	}
}

// TestFilterKeepLangKeepsAllowed: confidently-classified English and Spanish
// articles pass a keep_lang=en,es gate.
func TestFilterKeepLangKeepsAllowed(t *testing.T) {
	for name, text := range map[string]string{"english": langTextEN, "spanish": langTextES} {
		item := makeFilterItem("", "<p>"+text+"</p>")
		if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
			t.Fatalf("%s: Process: %v", name, err)
		}
		if item.Drop {
			t.Errorf("%s: expected Drop=false for allowed language", name)
		}
	}
}

// TestFilterKeepLangDropsForeign: confident foreign classifications drop —
// German is the Latin-script path, Russian/Japanese the distinct-script path.
func TestFilterKeepLangDropsForeign(t *testing.T) {
	for name, text := range map[string]string{"german": langTextDE, "russian": langTextRU, "japanese": langTextJA} {
		item := makeFilterItem("", "<p>"+text+"</p>")
		if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
			t.Fatalf("%s: Process: %v", name, err)
		}
		if !item.Drop {
			t.Errorf("%s: expected Drop=true for foreign language", name)
		}
	}
}

// TestFilterKeepLangFailOpenShortText: below the 24-rune floor nothing is
// judged — a 22-rune German greeting is kept.
func TestFilterKeepLangFailOpenShortText(t *testing.T) {
	item := makeFilterItem("", "Guten Morgen zusammen!")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for sub-floor text length")
	}
}

// TestFilterKeepLangFailOpenLowConfidence: Portuguese prose scores ~0.41 —
// well under the 0.8 gate — so the Latin-script sibling is kept, the
// documented fail-open leak direction (never a wanted article lost).
func TestFilterKeepLangFailOpenLowConfidence(t *testing.T) {
	item := makeFilterItem("", "<p>"+langTextPT+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for a low-confidence detection")
	}
}

// TestFilterKeepLangEmptyItemKept: no title, no content → nothing to judge.
func TestFilterKeepLangEmptyItemKept(t *testing.T) {
	item := makeFilterItem("", "")
	if err := runFilter(t, "#filter keep_lang=en,es", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if item.Drop {
		t.Error("expected Drop=false for an empty item")
	}
}

// TestFilterKeepLangStripsMarkup: heavy markup around foreign prose does not
// dilute detection (drops), and tag soup around English does not flip it to a
// confident foreign classification (kept).
func TestFilterKeepLangStripsMarkup(t *testing.T) {
	de := makeFilterItem("", `<div class="entry-content post"><p>`+langTextDE+`</p><img src="https://example.com/x.jpg" alt=""></div>`)
	if err := runFilter(t, "#filter keep_lang=en,es", de); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !de.Drop {
		t.Error("expected Drop=true for German prose in heavy markup")
	}
	en := makeFilterItem("", `<div data-x="qqzz"><p style="color:red">`+langTextEN+`</p></div>`)
	if err := runFilter(t, "#filter keep_lang=en,es", en); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if en.Drop {
		t.Error("expected Drop=false for English prose in tag soup")
	}
}

// TestFilterKeepLangComposes: keep_lang combines with other conditions in one
// token; any condition firing drops.
func TestFilterKeepLangComposes(t *testing.T) {
	// Passes min_words, fails the language gate → dropped.
	item := makeFilterItem("", "<p>"+langTextDE+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es min_words=5", item); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item.Drop {
		t.Error("expected Drop=true (language gate) with min_words also present")
	}
	// Passes the language gate, fails min_words → dropped.
	item2 := makeFilterItem("", "<p>"+langTextEN+"</p>")
	if err := runFilter(t, "#filter keep_lang=en,es min_words=100", item2); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !item2.Drop {
		t.Error("expected Drop=true (min_words) with keep_lang also present")
	}
}
```

Also add these two tokens to the `valid` slice in the existing
`TestFilterValidateAcceptsKnownParams`:

```go
		"#filter keep_lang=en,es",
		"#filter keep_lang=en,es min_words=5",
```

And add the import `"github.com/abadojack/whatlanggo"` to
`filter_test.go`'s import block (used by `TestParseKeepLangs`).

- [ ] **Step 2: Add the dependency, run tests to verify they fail**

```bash
cd backend && go get github.com/abadojack/whatlanggo@v1.0.1
go test ./mod/ -run 'TestParseKeepLangs|TestFilterKeepLang' -v
```

Expected: compile error — `undefined: parseKeepLangs`.

- [ ] **Step 3: Implement the condition**

In `backend/mod/filter.go`:

**(a)** Extend the doc comment's param list (after the `min_words=N` line):

```go
//	keep_lang=en,es         — drop when the article's language is confidently
//	                          detected (whatlanggo, ≥ 24 runes of extracted
//	                          text, confidence ≥ 0.8) as one NOT in the
//	                          comma-separated ISO 639-1 allowlist. Fail-open:
//	                          short text, low confidence, or an in-list
//	                          detection keeps the item.
```

**(b)** Imports: add `"unicode/utf8"` (stdlib group) and
`"github.com/abadojack/whatlanggo"` (external group, blank-line separated per
convention).

**(c)** File-scope declarations (below the doc comment, above `init`):

```go
// Fail-open language gate for keep_lang: only a confident classification
// outside the keep set drops an item.
const (
	langMinTextLen    = 24   // runes of extracted text below which we never judge
	langConfidenceMin = 0.8  // whatlanggo's own ReliableConfidenceThreshold
	langMaxTextLen    = 4096 // byte cap on the text fed to the detector
)

// iso6391ToLang maps lowercase ISO 639-1 codes to whatlanggo languages, built
// once from the library's table. 78 of its 84 languages expose a 639-1 code;
// the rest can't be named in keep_lang — a detected no-code language is never
// in the keep set, which is the correct allowlist behavior.
var iso6391ToLang = func() map[string]whatlanggo.Lang {
	m := make(map[string]whatlanggo.Lang, len(whatlanggo.Langs))
	for lang := range whatlanggo.Langs {
		if c := lang.Iso6391(); c != "" {
			m[c] = lang
		}
	}
	return m
}()
```

**(d)** Helpers (next to `parseRegexParam`):

```go
// parseKeepLangs parses a comma-separated ISO 639-1 code list ("en,es") into
// a whatlanggo language set. Unknown codes, empty elements, and an empty list
// are hard configuration errors, matching the malformed-regex contract.
func parseKeepLangs(val string) (map[whatlanggo.Lang]bool, error) {
	set := map[whatlanggo.Lang]bool{}
	for _, code := range strings.Split(val, ",") {
		code = strings.ToLower(strings.TrimSpace(code))
		if code == "" {
			return nil, fmt.Errorf("parameter keep_lang=%q: empty language code", val)
		}
		lang, ok := iso6391ToLang[code]
		if !ok {
			return nil, fmt.Errorf("parameter keep_lang=%q: unknown ISO 639-1 code %q", val, code)
		}
		set[lang] = true
	}
	return set, nil
}

// langOutsideSet reports whether the article's language is confidently
// detected as one NOT in set. Fail-open: short text, low confidence, or a
// detected language in the set all return false (keep).
func langOutsideSet(title, content string, set map[whatlanggo.Lang]bool) bool {
	text := extractText(title, content, langMaxTextLen)
	if utf8.RuneCountInString(text) < langMinTextLen {
		return false
	}
	info := whatlanggo.Detect(text)
	if info.Confidence < langConfidenceMin {
		return false
	}
	return !set[info.Lang]
}
```

**(e)** In the `Register("filter", ...)` factory, next to the regex `cache`,
add the per-instance parsed-set cache (same pattern, same no-locking
rationale):

```go
		langSets := map[string]map[whatlanggo.Lang]bool{}
		keepSet := func(val string) (map[whatlanggo.Lang]bool, error) {
			if s, ok := langSets[val]; ok {
				return s, nil
			}
			s, err := parseKeepLangs(val)
			if err != nil {
				return nil, err
			}
			langSets[val] = s
			return s, nil
		}
```

**(f)** Add `"keep_lang"` to the `p.only(...)` call:

```go
			if err := p.only("drop_title", "keep_title", "drop_content", "keep_content", "min_words", "keep_lang"); err != nil {
				return err
			}
```

**(g)** The condition itself, **after** the `min_words` block (last — the
cheap conditions short-circuit before detection runs), before the final
`return nil`:

```go
			// --- keep_lang ---
			if v, ok := p["keep_lang"]; ok {
				set, err := keepSet(v)
				if err != nil {
					return err
				}
				if langOutsideSet(i.Title, i.Content, set) {
					i.Drop = true
					return nil
				}
			}
```

- [ ] **Step 4: Run the mod tests, then the full backend suite**

```bash
go test ./mod/ -v -run 'TestParseKeepLangs|TestFilterKeepLang|TestFilterValidate|TestExtractText'
go test ./...
```

Expected: all PASS (existing tests included — the `p.only` set grew but every
old token stays valid).

- [ ] **Step 5: Commit**

```bash
git status --short   # confirm only filter.go, filter_test.go, go.mod, go.sum changed
git add backend/mod/filter.go backend/mod/filter_test.go backend/go.mod backend/go.sum
git commit -m "feat(mod): #filter keep_lang= — ingest-time language allowlist (whatlanggo, fail-open)"
```

---

### Task 3: docs + full verify

**Files:**
- Modify: `backend/README.md` (the `### #filter` section, ~line 477)
- Modify: `backend/CLAUDE.md` (the `#filter` bullet in the Module System list)

- [ ] **Step 1: README — parameter row + example**

In the `### #filter` parameter table, after the `min_words` row, add:

```markdown
| `keep_lang` | ISO 639-1 codes | Drop when the language is confidently detected as one **not** in the list |
```

After the regex-syntax paragraph (ending "…not `drop_title=/breaking news/`."),
add:

```markdown
Language detection (`keep_lang`) is offline (trigram-based, via whatlanggo) and **fail-open**: an item is dropped only when at least 24 runes of plain text (title + HTML-stripped content) are detected at ≥ 0.8 confidence as a language outside the list. Short posts, uncertain detections, and empty items always pass — the failure mode is a stray foreign article surviving, never a wanted article lost. Codes are case-insensitive ISO 639-1 (`en,es`); an unknown code is a hard configuration error.
```

And extend the example block:

```bash
# Keep only English and Spanish articles
srr recipe set eng-es -p "#default" -p "#filter keep_lang=en,es"
srr feed upd 7 -r eng-es
```

- [ ] **Step 2: backend/CLAUDE.md — extend the `#filter` bullet**

In the Module System list, the bullet currently reads:

> `#filter` — content-based item dropping (`filter.go`). Params (all optional; item dropped if ANY condition fires): `drop_title=/regex/[i]`, `keep_title=/regex/[i]`, `drop_content=/regex/[i]`, `keep_content=/regex/[i]`, `min_words=N`. On a match sets `i.Drop=true; return nil`. Unknown params / bad regex / bad int are hard errors. Does NOT mutate GUID/Published/Title/Content/Link.

Add `keep_lang=en,es` to the param list and append one sentence, so it reads:

> `#filter` — content-based item dropping (`filter.go`). Params (all optional; item dropped if ANY condition fires): `drop_title=/regex/[i]`, `keep_title=/regex/[i]`, `drop_content=/regex/[i]`, `keep_content=/regex/[i]`, `min_words=N`, `keep_lang=en,es` (ISO 639-1 allowlist; whatlanggo trigram detection over title + HTML-stripped content — `extractText` in `helper_html.go`, 4 KiB cap; **fail-open**: drops only at ≥ 24 runes AND confidence ≥ 0.8 AND detected language outside the set, evaluated last so the cheap conditions short-circuit first). On a match sets `i.Drop=true; return nil`. Unknown params / bad regex / bad int / unknown language code are hard errors. Does NOT mutate GUID/Published/Title/Content/Link.

- [ ] **Step 3: Full gate**

Run from the repo root: `make verify-be`
Expected: vet + gofmt + lint + build + test + generate-check all green (no
format atom or struct tag changed, so `format.gen.ts` is untouched).
If golangci-lint reports stale-looking errors on lines that look fine, run
`golangci-lint cache clean` once and retry (known stale-cache trap).

- [ ] **Step 4: Commit**

```bash
git status --short   # confirm only the two docs changed
git add backend/README.md backend/CLAUDE.md
git commit -m "docs: document #filter keep_lang across README and CLAUDE.md"
```
