package mod

import (
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
	return info.Lang.Iso6391()
}

// iso6391Codes is the set of ISO 639-1 codes whatlanggo can produce (78 of
// its 84 languages carry one) — the validation table for #filter keep_lang's
// allowlist, so a typo'd code is a hard configuration error.
var iso6391Codes = func() map[string]bool {
	m := make(map[string]bool, len(whatlanggo.Langs))
	for lang := range whatlanggo.Langs {
		if c := lang.Iso6391(); c != "" {
			m[c] = true
		}
	}
	return m
}()
