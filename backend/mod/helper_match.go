package mod

import (
	"fmt"
	"regexp"
	"strconv"
)

// The article MATCHER — one compiled content predicate, shared syntax with
// #filter (finding FMT5, the keyword-watchlist axis).
//
// WHY IT LIVES HERE. Keyword watchlists (backend/watch.go) need to ask exactly
// the question #filter already asks — "does this article's title/content/
// language look like X?" — and there must not be two answers to it. So the
// vocabulary, the /regex/[i] grammar, the quote-aware field split and the
// language folding are the SAME code, not a second implementation that drifts
// on the day someone teaches one side a flag the other does not have. What
// differs is the verb, and only the verb:
//
//	#filter says DROP when a condition fires. Any condition matching is enough,
//	        and an unknown language keeps the item (fail-open — the failure mode
//	        must never be an article silently lost).
//	Match   says THIS ARTICLE IS ONE OF THE ONES I WATCH. Every condition must
//	        hold (a rule is one description, not a list of alternatives), and an
//	        unknown language does NOT match a lang= rule (fail-closed — a watch
//	        lane must be positive evidence, and claiming an unstamped article is
//	        English would poison the lane with noise nobody can filter back out).
//
// Both inversions are deliberate; each is the safe direction for its verb.
//
// PARSE EVERYTHING BEFORE EVALUATING ANYTHING. #filter's processor carries that
// rule as a comment and a hand-rolled ordering, because it is a per-item
// callback and a firing condition used to return before a malformed LATER param
// was ever looked at — which let a broken pipe validate clean and then silently
// ingest nothing forever. A Match cannot have that bug by construction: parsing
// is a CONSTRUCTOR that happens once, when the operator declares the rule
// (`srr watch set` rejects it there), and evaluation touches no strings it has
// not already compiled.
//
// Parameters (all optional individually, at least one required):
//
//	title=/regex/[i]     — the article title matches
//	content=/regex/[i]   — the stored content matches
//	any=/regex/[i]       — title OR content matches
//	lang=en,es           — the article's stamped language is in the allowlist
//	min_words=N          — the content holds at least N whitespace-separated words
//
// As in #filter, a rule token is split on whitespace before its parameters are
// parsed, so a pattern containing a literal space needs either a metacharacter
// (any=/breaking\s+news/) or QUOTES AROUND THE WHOLE VALUE, delimiters included
// (any="/breaking news/"). A bare quoted phrase — any="breaking news" — is not a
// regex and is rejected, which is the mistake worth naming here because it is
// the one an operator makes first.

// matchParams is the allowed key set, named once so the error message and the
// gate can never disagree.
var matchParams = []string{"title", "content", "any", "lang", "min_words"}

// Match is a compiled article predicate. Immutable after ParseMatch and safe
// for concurrent use — the regexps and the language set are read-only.
type Match struct {
	title    *regexp.Regexp
	content  *regexp.Regexp
	any      *regexp.Regexp
	langs    map[string]bool
	minWords int // -1 when the parameter is absent
}

// ParseMatch compiles a rule specification. Every error is a CONFIGURATION
// error reported to the operator at declaration time — there is deliberately no
// lenient mode, because a watch rule that silently matches nothing is
// indistinguishable from one whose subject never appeared.
func ParseMatch(spec string) (*Match, error) {
	fields, err := splitParamFields(spec)
	if err != nil {
		return nil, err
	}
	p, err := parseParams(fields)
	if err != nil {
		return nil, err
	}
	if err := p.only(matchParams...); err != nil {
		return nil, err
	}

	m := &Match{minWords: -1}
	for _, s := range []struct {
		key string
		dst **regexp.Regexp
	}{
		{"title", &m.title},
		{"content", &m.content},
		{"any", &m.any},
	} {
		if v, ok := p[s.key]; ok {
			if *s.dst, err = parseRegexParam(s.key, v); err != nil {
				return nil, err
			}
		}
	}
	if v, ok := p["min_words"]; ok {
		if m.minWords, err = strconv.Atoi(v); err != nil || m.minWords < 0 {
			return nil, fmt.Errorf("parameter min_words=%q: must be a non-negative integer", v)
		}
	}
	if v, ok := p["lang"]; ok {
		// Same parser #filter's keep_lang uses, so a macrolanguage code admits
		// every variety detection can report under it and "EN"/"en-US"/"en" are
		// one code on both sides of the comparison.
		if m.langs, err = parseKeepLangs(v); err != nil {
			return nil, err
		}
	}
	if m.title == nil && m.content == nil && m.any == nil && m.langs == nil && m.minWords < 0 {
		return nil, fmt.Errorf("a rule needs at least one condition (%s)", joinKeys(matchParams))
	}
	return m, nil
}

// Match reports whether an article satisfies EVERY declared condition. It takes
// the three stored fields rather than a *RawItem because its caller is the pack
// writer, which holds an ArticleData — keeping this decoupled from the ingest
// wire type is what lets one predicate serve both sides.
func (m *Match) Match(title, content, lang string) bool {
	switch {
	case m == nil:
		return false
	case m.title != nil && !m.title.MatchString(title):
		return false
	case m.content != nil && !m.content.MatchString(content):
		return false
	case m.any != nil && !m.any.MatchString(title) && !m.any.MatchString(content):
		return false
	case m.minWords >= 0 && wordCount(content) < m.minWords:
		return false
	case m.langs != nil && !m.langs[normalizeLang(lang)]:
		// Fail-CLOSED, unlike #filter's langAllowed: an empty lang normalizes to
		// "" which is in no allowlist, so an article detection could not classify
		// is never claimed by a language rule. See the file comment.
		return false
	}
	return true
}

// joinKeys renders the allowed key set for the "needs at least one condition"
// error, as `key=` hints rather than bare names so the message doubles as the
// syntax reminder.
func joinKeys(keys []string) string {
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += ", "
		}
		out += k + "="
	}
	return out
}
