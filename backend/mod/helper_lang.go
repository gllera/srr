package mod

import (
	"strings"
	"unicode/utf8"

	"github.com/abadojack/whatlanggo"
)

// Fail-open gate for the always-on language stamp the caller applies before
// the pipeline (processItem): only a confident classification is ever
// reported.
const (
	langMinTextLen    = 24   // runes of extracted text below which we never judge
	langConfidenceMin = 0.8  // whatlanggo's own ReliableConfidenceThreshold
	langMaxTextLen    = 4096 // byte cap on the text fed to the detector
)

// DetectLang returns the article's confidently-detected ISO 639-1 code — at
// least langMinTextLen runes of extracted text classified at ≥
// langConfidenceMin confidence — or "" on the fail-open path (short text, low
// confidence, or a detected language with no 639-1 code). The store-ready
// form processItem stamps onto RawItem.Lang.
func DetectLang(title, content string) string {
	text := extractText(title, content, langMaxTextLen)
	if utf8.RuneCountInString(text) < langMinTextLen {
		return ""
	}
	info := whatlanggo.Detect(text)
	if info.Confidence < langConfidenceMin {
		return ""
	}
	return langCode(info.Lang)
}

// iso6391Extra fills gaps in whatlanggo's own Lang→ISO 639-1 table: it maps
// these two to "" ("No iso639-1"), but the languages they name DO carry a
// 639-1 code. Without the override a Persian article is never stampable and
// `#filter keep_lang=fa` is rejected as an unknown code — which fails
// Module.Validate and takes the whole feed down (Feed.Fetch sets ferr and
// skips it).
var iso6391Extra = map[whatlanggo.Lang]string{
	whatlanggo.Pes: "fa", // Western Persian → Persian
	whatlanggo.Ydd: "yi", // Eastern Yiddish → Yiddish
}

// langCode is the one Lang→ISO 639-1 mapping, whatlanggo's table corrected by
// iso6391Extra. "" means the language genuinely has no 639-1 code (Cebuano,
// Ilocano, Maithili, Saraiki are 639-3 only) — detection then fails open.
func langCode(l whatlanggo.Lang) string {
	if c := l.Iso6391(); c != "" {
		return c
	}
	return iso6391Extra[l]
}

// langMacro maps a 639-1 MACROLANGUAGE code to every code detection can
// actually produce under it, plus itself. whatlanggo only ever classifies the
// Norwegian varieties (nb Bokmål / nn Nynorsk), never "no" — so a keep_lang
// allowlist naming "no" must admit BOTH, or a Norwegian feed configured the
// obvious way silently discards its Nynorsk half. Expanded on the config side
// only; normalizeLang leaves an item's own code alone.
var langMacro = map[string][]string{"no": {"no", "nb", "nn"}}

// normalizeLang folds a language tag to the bare lowercase 639-1 subtag this
// package compares on: "ES" → "es", "es-ES" → "es", "pt_BR" → "pt". Applied to
// BOTH sides — the keep_lang allowlist and the item's Lang — so a value
// declared over the external-mod wire (an ingest strategy copying an RSS
// <language> verbatim) matches the same set the config built. It deliberately
// does NOT rewrite one language to another; see langMacro.
func normalizeLang(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i >= 0 {
		s = s[:i]
	}
	return s
}

// validLangCode reports whether a code may appear in a keep_lang allowlist:
// one detection can produce, or a macrolanguage standing for a set of them.
func validLangCode(code string) bool {
	return iso6391Codes[code] || langMacro[code] != nil
}

// iso6391Codes is the set of ISO 639-1 codes detection can produce — the
// validation table for #filter keep_lang's allowlist, so a typo'd code is a
// hard configuration error.
var iso6391Codes = func() map[string]bool {
	m := make(map[string]bool, len(whatlanggo.Langs))
	for lang := range whatlanggo.Langs {
		if c := langCode(lang); c != "" {
			m[c] = true
		}
	}
	return m
}()
