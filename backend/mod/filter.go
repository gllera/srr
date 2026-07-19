package mod

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/abadojack/whatlanggo"
)

// #filter — content-based item dropping.
//
// A pipeline step that deliberately DROPs items that match (or fail to match)
// user-configurable predicates. Dropped items are never written to the packs,
// but their GUID is retained in the feed's dedup boundary so they are not
// re-evaluated on subsequent fetches. A dropped item is NOT a pipeline error;
// processItem returns nil and sets i.Drop=true.
//
// Params (all optional; an item is dropped if it matches ANY active condition):
//
//	drop_title=/regex/[i]   — drop when title matches the regex (flag i = case-insensitive)
//	keep_title=/regex/[i]   — drop when title does NOT match the regex
//	drop_content=/regex/[i] — drop when content matches the regex
//	keep_content=/regex/[i] — drop when content does NOT match the regex
//	min_words=N             — drop when the plain-text word count of content is below N
//	keep_lang=en,es         — drop when the article's language is confidently
//	                          detected (whatlanggo, ≥ 24 runes of extracted
//	                          text, confidence ≥ 0.8) as one NOT in the
//	                          comma-separated ISO 639-1 allowlist. Fail-open:
//	                          short text, low confidence, or an in-list
//	                          detection keeps the item.
//
// Regex syntax: /pattern/ or /pattern/i (the only supported flag is i).
// A malformed regex or unrecognised param is a hard configuration error.
//
// NOTE: a pipeline token is split on whitespace before its parameters are parsed
// (see mod.Module.Process), so a regex param value cannot contain a LITERAL space.
// Use a whitespace metacharacter instead — drop_title=/breaking\s+news/ or
// drop_title=/breaking[ ]news/ — NOT drop_title=/breaking news/, which is rejected
// as a malformed parameter.
//
// #filter does not touch GUID, Published, Title, Content, or Link.

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

func init() {
	Register("filter", func() Processor {
		// Compile each distinct regex param value once per Module instance (the
		// factory runs once per New()), not once per article. *mod.Module is pooled
		// per-worker (procPool, never shared concurrently), so this map needs no
		// locking. Keyed by the param VALUE (a value compiles to the same regex
		// regardless of which param named it).
		cache := map[string]*regexp.Regexp{}
		compiled := func(key, val string) (*regexp.Regexp, error) {
			if re, ok := cache[val]; ok {
				return re, nil
			}
			re, err := parseRegexParam(key, val)
			if err != nil {
				return nil, err
			}
			cache[val] = re
			return re, nil
		}
		// Same idea for keep_lang: parse each distinct code-list value once
		// per Module instance.
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
		return func(ctx context.Context, p Params, i *RawItem) error {
			if err := p.only("drop_title", "keep_title", "drop_content", "keep_content", "min_words", "keep_lang"); err != nil {
				return err
			}

			// --- drop_title ---
			if v, ok := p["drop_title"]; ok {
				re, err := compiled("drop_title", v)
				if err != nil {
					return err
				}
				if re.MatchString(i.Title) {
					i.Drop = true
					return nil
				}
			}

			// --- keep_title ---
			if v, ok := p["keep_title"]; ok {
				re, err := compiled("keep_title", v)
				if err != nil {
					return err
				}
				if !re.MatchString(i.Title) {
					i.Drop = true
					return nil
				}
			}

			// --- drop_content ---
			if v, ok := p["drop_content"]; ok {
				re, err := compiled("drop_content", v)
				if err != nil {
					return err
				}
				if re.MatchString(i.Content) {
					i.Drop = true
					return nil
				}
			}

			// --- keep_content ---
			if v, ok := p["keep_content"]; ok {
				re, err := compiled("keep_content", v)
				if err != nil {
					return err
				}
				if !re.MatchString(i.Content) {
					i.Drop = true
					return nil
				}
			}

			// --- min_words ---
			if v, ok := p["min_words"]; ok {
				n, err := strconv.Atoi(v)
				if err != nil || n < 0 {
					return fmt.Errorf("parameter min_words=%q: must be a non-negative integer", v)
				}
				if wordCount(i.Content) < n {
					i.Drop = true
					return nil
				}
			}

			// --- keep_lang --- (last: the cheap conditions short-circuit
			// before detection runs)
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

			return nil
		}
	})
}

// parseRegexParam parses a /pattern/ or /pattern/i value for the named param.
// It returns a compiled *regexp.Regexp. The only supported flag is i
// (case-insensitive); any other suffix character is rejected.
func parseRegexParam(key, val string) (*regexp.Regexp, error) {
	if !strings.HasPrefix(val, "/") {
		return nil, fmt.Errorf("parameter %s=%q: must have the form /pattern/ or /pattern/i", key, val)
	}
	// Find the closing slash.
	// The pattern may itself contain slashes, so look from the end.
	last := strings.LastIndex(val[1:], "/")
	if last < 0 {
		return nil, fmt.Errorf("parameter %s=%q: missing closing '/'", key, val)
	}
	// last is relative to val[1:], so absolute index is last+1.
	pattern := val[1 : last+1]
	if pattern == "" {
		return nil, fmt.Errorf("parameter %s=%q: empty pattern matches everything; use a non-empty regex", key, val)
	}
	flags := val[last+2:]
	for _, f := range flags {
		if f != 'i' {
			return nil, fmt.Errorf("parameter %s=%q: unsupported regex flag %q (only 'i' is supported)", key, val, f)
		}
	}
	expr := pattern
	if strings.Contains(flags, "i") {
		expr = "(?i)" + pattern
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("parameter %s=%q: invalid regex: %w", key, val, err)
	}
	return re, nil
}

// wordCount counts whitespace-separated words in s. HTML tags and attributes
// are included in the count as plain text, which is acceptable for a rough
// word-count filter and avoids a dependency on an HTML parser here.
func wordCount(s string) int {
	return len(strings.Fields(s))
}

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
