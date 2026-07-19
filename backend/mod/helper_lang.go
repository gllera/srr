package mod

import (
	"unicode/utf8"

	"github.com/abadojack/whatlanggo"
)

// Language detection shared by #filter keep_lang and the always-on stamp the
// caller applies after the pipeline (processItem). Fail-open gate: only a
// confident classification outside these bounds is ever reported.
const (
	langMinTextLen    = 24   // runes of extracted text below which we never judge
	langConfidenceMin = 0.8  // whatlanggo's own ReliableConfidenceThreshold
	langMaxTextLen    = 4096 // byte cap on the text fed to the detector
)

// detectLang returns the article's confidently-detected language: at least
// langMinTextLen runes of extracted text classified at ≥ langConfidenceMin
// confidence. ok=false is the fail-open path (short text, low confidence) —
// callers neither drop nor stamp then.
func detectLang(title, content string) (whatlanggo.Lang, bool) {
	text := extractText(title, content, langMaxTextLen)
	if utf8.RuneCountInString(text) < langMinTextLen {
		return 0, false
	}
	info := whatlanggo.Detect(text)
	if info.Confidence < langConfidenceMin {
		return 0, false
	}
	return info.Lang, true
}

// DetectLang returns the article's confidently-detected ISO 639-1 code, or ""
// when detection is uncertain (the fail-open path) or the detected language
// has no 639-1 code — the store-ready form for RawItem.Lang. Callers that
// need to distinguish "uncertain" from "confident but code-less" (keep_lang's
// allowlist does) use detectLang directly.
func DetectLang(title, content string) string {
	if lang, ok := detectLang(title, content); ok {
		return lang.Iso6391()
	}
	return ""
}
