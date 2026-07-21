# Design: `asset-peek` + `asset-process {output}`

Date: 2026-06-25
Status: approved

## Goal

Self-hosted assets should be stored under their **true (post-process) extension**
and **Content-Type**, and SRR should know an asset's type (and whether it is
processable) up front. Today the store key keeps the *source* URL extension even
when `asset-process` transcodes the bytes (e.g. a `.gif` source stored as WebP),
which serves the wrong Content-Type on extension-driven static servers (nginx).

## Two operator commands (both optional, independent)

### `asset-peek` (`--asset-peek` / `SRR_ASSET_PEEK`, supports `{input}`)

Run on the **source** cache file; prints one JSON object to stdout:

```json
{ "mimetype": "image/webp", "extension": "webp", "supported": true }
```

Identifies the asset and predicts how it will look **after** `asset-process`.
`{input}` is substituted per-arg (same rules as `asset-process`); with no token
the cache path is appended as the final arg. The operator keeps peek consistent
with their process command: for a type `asset-process` transcodes, peek predicts
the output type and `supported:true`; for a type it won't handle, peek reports
the *source* type and `supported:false`.

### `asset-process` gains `{output}`

When the command contains `{output}`, SRR creates a temp file, substitutes its
path, runs the command, then reads the **processed bytes from that file** and a
JSON `{mimetype, extension}` from **stdout**. With no `{output}` token: today's
behavior (bytes on stdout, no JSON). `{input}` is unchanged.

## `UploadCacheRef` flow

```
1. guards + read source bytes + sha256(source)              (unchanged)
2. asset-peek configured? → run on source → {mimetype, extension, supported}
                            → stored-ext = peek.extension;  CT = peek.mimetype
   not configured          → stored-ext = source ext;  supported = true;  CT = ""
3. key = contentHashKey(stored-ext, sourceHash)             ← key carries OUTPUT ext
4. existence check on key → hit: return key (asset-process NOT run)
5. miss → payload + CT:
     supported && asset-process set:
        {output} form → bytes from file, JSON from stdout; CT = process.mimetype
        stdout form   → bytes from stdout (today);          CT = peek.mimetype
     else (unsupported, or no process) → payload = original bytes; CT = peek.mimetype
6. size cap on payload                                       (unchanged)
7. AtomicPut(key, payload, CT)
```

- **peek runs on every asset** (pre-dedup, to fix the key extension). **process
  still runs only on a miss** (the expensive transcode stays skip-on-hit).
- **`supported:false`** → host the original bytes, skip `asset-process`, store
  under `peek.extension`/`peek.mimetype` (peek reports the real source type for
  an unsupported asset).
- **Disagreement** (`process.extension` ≠ `peek.extension`): keep the peek-based
  key (already used for dedup), log WARN.

## Fail-soft (never wedge a feed)

- peek non-zero exit / bad JSON / empty → fall back to source-ext,
  `supported=true`, no CT (WARN).
- process error, or `{output}` empty/missing file, or bad stdout JSON → upload
  original, CT from peek (WARN).

## Backend interface change (Content-Type / Content-Encoding)

`AtomicPut(ctx, key, r)` → `AtomicPut(ctx, key, r, meta store.ObjectMeta)`, where
`ObjectMeta{ContentType, ContentEncoding string}`. Three callers: `assets.go`
passes the peek/process mimetype+encoding; `db.go` (db.gz) and `db_out.go` pass
the zero value. In S3 the explicit `ContentType` is stamped directly,
**defaulting to `application/octet-stream` when unset** — SRR no longer derives a
type from the key extension or sniffs the bytes (peek/process is the single
source of truth; packs are opaque gzip blobs). `ContentEncoding` is stamped only
when set. Local & SFTP store plain files — they ignore `meta` (their headers are
the static server's at request time; the peek-corrected *extension* is what fixes
them).

The `asset-peek` JSON gains an optional `encoding` field
(`{mimetype, extension, supported, encoding}`) and the `asset-process` `{output}`
JSON likewise (`{mimetype, extension, encoding}`); both feed `ObjectMeta`. When
both run, the `{output}`-mode process metadata (the actual result) overrides
peek's prediction for Content-Type/-Encoding.

## Rollout (3 commits — as built)

1. `AtomicPut` gains `store.ObjectMeta` (Content-Type/-Encoding); S3 stamps the
   explicit type, defaulting to `application/octet-stream` and dropping the
   extension/sniff derivation.
2. `asset-process {output}` + `{mimetype,extension,encoding}` JSON, threading the
   declared type/encoding as the object's `ObjectMeta`.
3. `asset-peek` + key-from-peek extension + `supported` gating + `peek` Content-
   Type/-Encoding; `{output}`-mode process metadata overrides peek's.

## Tests

peek sets stored extension & Content-Type; `supported:false` hosts original &
skips process; `{output}` reads bytes-from-file + JSON-stdout; peek/process
fail-soft paths; AtomicPut signature in store tests; S3 uses explicit CT when
given.
