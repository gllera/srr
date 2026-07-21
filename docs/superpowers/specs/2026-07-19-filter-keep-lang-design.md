# Language filtering at ingest — `#filter keep_lang=` — design

**Date:** 2026-07-19
**Scope:** backend (`srr`), `mod/` only

## Goal

Drop articles at ingest whose language is confidently detected as something
other than an operator-chosen allowlist (motivating case: keep only English and
Spanish). Detection is offline, per article, and rides the existing `#filter`
pipeline mod as one new parameter:

```
#filter keep_lang=en,es
```

Like every `#filter` condition, a match sets `i.Drop=true`: the item is never
written to the packs, and its GUID stays in the feed's dedup boundary so it is
not re-evaluated on subsequent fetches. Configurable per recipe or per feed
like any pipe step — no new mod name, no data-contract change.

## Non-goals

- No stored per-article language field, no reader/frontend involvement, no
  format or `format.gen.ts` change. Filtering is ingest-time-only and
  irreversible per item (the accepted trade-off; same as every `#filter` drop).
- No `drop_lang=` denylist counterpart (add later if ever wanted — the
  allowlist is the requested use case).
- No configurable confidence threshold or minimum-length knob. Both are
  conservative code constants; promote to params only if practice demands it.
- No external detector (fastText etc.) and no network I/O — `#filter` stays a
  pure-CPU, ctx-free mod.
- No channel-level `<language>` shortcut: detection is per article, which is
  what mixed-language feeds need, and the filter only runs where configured.

## Surface

One new `#filter` parameter, joining `drop_title`/`keep_title`/`drop_content`/
`keep_content`/`min_words` in the `p.only(...)` allowlist:

| Param | Value | Fires (⇒ drop) when |
|---|---|---|
| `keep_lang` | comma-separated ISO 639-1 codes, e.g. `en,es` | the detector **confidently** identifies the article's language and it is **not** in the set |

- Codes are case-insensitive (`EN,es` ≡ `en,es`); duplicates are harmless.
- An unknown code, an empty list, or an empty element (`en,,es`) is a **hard
  configuration error** at first use — same contract as a malformed regex. Read
  via direct map access like the regex conditions; the code-list parser rejects
  the empty shapes itself (an empty `keep_lang=` value splits to one empty
  element). `Module.Validate` runs each built-in once against a throwaway item,
  so the error also fires at pipe-validation time with no extra wiring.
- Evaluated **last** among the conditions, so the cheap regex/word-count
  conditions short-circuit before detection runs.

## Detection semantics

New dependency: `github.com/abadojack/whatlanggo` — pure Go, trigram-based, no
model files, so the static `CGO_ENABLED=0` release builds and the ARM boxes are
unaffected (negligible binary/memory cost).

**Input text.** `extractText(title, content)`: title, then the content's text
nodes — content parsed via the existing `parseBodyHTML` (`helper_html.go`),
walked collecting text node data while skipping `<script>`/`<style>` subtrees
(`#filter` may run pre-`#sanitize`, so they can still be present). Segments are
joined with spaces, whitespace-collapsed, and collection stops once
`langMaxTextLen` = 4096 bytes are gathered — ample for trigram detection,
bounds CPU on huge articles. A content fragment that fails to parse
contributes nothing (title may still suffice).

**Fail-open gate.** The item is **kept** unless ALL of:

1. extracted text ≥ `langMinTextLen` = 24 runes (below that, detection is
   noise — the microblog/one-liner/emoji case),
2. `whatlanggo.Detect` confidence ≥ `langConfidenceMin` = 0.8 (matching the
   library's own `ReliableConfidenceThreshold`; probe-verified: clear
   single-language prose scores 0.7–1.0, Latin-script confusables like a short
   Portuguese paragraph score ~0.4), and
3. the detected `whatlanggo.Lang` is not in the keep set (the set is parsed
   from ISO 639-1 codes into `Lang` values up front, so the per-item check is
   a plain set lookup — no per-item code mapping).

Only a confident foreign classification drops. Empty text, low confidence,
short text, or a detected language in the set all keep the item. Mixed-language
articles resolve to the dominant language.

**Per-instance state.** Mirroring the compiled-regex cache: the parsed keep set
is cached per `*mod.Module` instance keyed by the raw param value (pooled
per-worker, no locking), and the ISO-639-1→`whatlanggo.Lang` lookup table is
built once. Validation of the code list happens at that first parse — hard
error, not per-item noise.

## Configuration examples

```bash
# Recipe: sanitize/minify, then language-gate
srr recipe set eng-es -p "#default" -p "#filter keep_lang=en,es"
srr feed upd 7 -r eng-es

# Or a feed-level override on one noisy feed only
srr feed upd 12 -p "#default" -p "#filter keep_lang=en,es"
```

No ordering constraint relative to other mods (HTML is stripped internally);
combining with regex conditions in one token works as today (`#filter
keep_lang=en,es min_words=20`).

## Files touched

- **`backend/mod/filter.go`** — the `keep_lang` condition (parse/validate the
  code set, the fail-open gate, the constants `langMinTextLen`/
  `langConfidenceMin`/`langMaxTextLen`), doc-comment update.
- **`backend/mod/helper_html.go`** — `extractText` (HTML→plain-text walk with
  the byte cap; a general helper, so it lives with the other HTML helpers).
- **`backend/mod/filter_test.go`** — see Testing.
- **`backend/go.mod` / `go.sum`** — add `whatlanggo`.
- **`backend/README.md`** — `keep_lang` row + example in the `#filter` section.
- **`backend/CLAUDE.md`** — extend the `#filter` bullet in the module list.
- Root `CLAUDE.md` needs nothing (it names `#filter` but documents no params).

## Testing / verification

Unit tests in `filter_test.go`, existing style:

- English kept, Spanish kept (each > 24 runes, unambiguous prose).
- German, Russian, Japanese articles dropped (distinct-script cases like
  Russian/Japanese are the detector's strongest; German covers the
  Latin-script drop path).
- Short foreign text (< 24 runes) kept — the length floor.
- Empty content + empty title kept.
- HTML markup stripped before detection (foreign prose wrapped in heavy
  markup still drops; an English article with foreign-looking tag soup stays).
- `<script>`/`<style>` contents excluded from the sample.
- Config errors: unknown code (`keep_lang=xx`), empty value, empty element —
  all hard errors.
- `keep_lang` composes with an existing condition in one token.
- Existing conditions still pass untouched (regression: the `p.only` set grew).

Test texts must be deterministic for whatlanggo (it is — pure trigram math);
choose sample sentences long and idiomatic enough to clear the 0.8 bar.
`make verify-be` green (vet, gofmt, lint, build, test, generate-check — the
generator is unaffected since no format atom or struct tag changes).

## Risks / edge cases

- **Latin-script siblings** (Portuguese/Italian/French/Catalan vs Spanish) are
  the realistic misclassification zone. The 0.8 confidence floor pushes these
  to "keep when unsure" — the failure mode is a stray foreign article
  surviving, never a wanted article silently lost. If practice shows leakage,
  tightening is a constant tweak (or the param-ization we deferred).
- **whatlanggo maintenance**: the library is stable but not very active.
  Acceptable for a leaf dependency with a trivial API; if it ever must go, the
  `keep_lang` surface hides the detector — swapping to lingua-go or an
  external command is a contained change.
- **Titleless/short feeds** (`nt` microblog feeds): most items will sit under
  the length floor and pass through unfiltered. Expected and documented — this
  filter is for prose feeds; it deliberately does nothing on content it cannot
  judge.
- **Sanitizer interaction**: none — detection strips HTML itself, so the
  token works before or after `#default`.
