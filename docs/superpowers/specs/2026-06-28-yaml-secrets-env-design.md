# Design: `secrets:` section in `srr.yaml` → ingest/mod command env

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review
**Scope:** `backend/` only — operator config, not part of the writer↔reader data contract.

## Problem

External ingest strategies and external (shell) mods run with `cmd.Env = os.Environ()` —
a verbatim snapshot of `srrb`'s own process environment, taken once at `New()`
(`ingest/main.go` `Fetcher.env`, `mod/main.go` `Module.env`). The only way to pass a
secret (API token, credential) to such a command today is to set it in the `srrb`
process environment (systemd `Environment=`/`EnvironmentFile=`, shell export, or an
inline `KEY=val cmd` in the recipe). There is no way to declare it in `srr.yaml`
alongside the rest of SRR's configuration.

`srr.yaml` is parsed by two consumers — `kongyaml.Loader` (kong flags) and
`store.LoadConfigs` (backend `s3:`/`sftp:` sections) — and neither supports an
arbitrary env-var map.

## Goal

Add an optional top-level `secrets:` section to `srr.yaml`: a flat map of env-var
name → value, merged into the environment of **external ingest and external mod
commands**.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Scope** | Ingest + mod commands only | Literal to the request. asset-process/asset-peek are excluded (and excluded *by construction* — see below). |
| **Precedence** | `srr.yaml` secrets **win** over the ambient process env | Config file is authoritative for these declared secrets. |
| **`srr config` output** | Masked — keys listed, values `***` | Discoverable that a secret is set; safe to screenshot/paste; fixed mask doesn't leak value length. |
| **Value model** | Literal values only | No `${VAR}` expansion, no file-reference indirection (YAGNI). |
| **Granularity** | Global to all ingest/mod commands | No per-feed/per-recipe scoping (YAGNI). |

## Non-goals

- No `${VAR}` interpolation or file-reference indirection — literal values only.
- No per-feed / per-recipe secret scoping — secrets are global.
- No encryption-at-rest — `srr.yaml` stays plaintext; operator secures the file
  (doc note: `chmod 600`).
- asset-process / asset-peek commands do **not** receive the secrets.

## YAML shape

A new optional top-level `secrets:` key, a flat string map. Absent ⇒ no-op.

```yaml
secrets:
  TG_API_ID: "12345"
  TG_API_HASH: "abcdef0123456789..."
  MY_TOKEN: "s3cr3t"
```

This coexists safely with the existing `s3:`/`sftp:` sections:

- **kong's YAML resolver** is queried per-flag; it only looks up keys that map to a
  flag, so an unknown top-level `secrets:` key is never inspected (same reason `s3:`/
  `sftp:` don't trip kong).
- **`store.LoadConfigs`** unmarshals into `map[string]yaml.Node` but only strict-decodes
  the nodes whose key matches a *registered backend scheme*; `secrets` is not a scheme,
  so it is ignored there.

Therefore `secrets` needs its own dedicated parse path.

## Architecture

Chosen approach (**A** of the three considered):

> `main` parses the `secrets:` section and pushes it into the `mod` package via a
> setter; `mod` owns the merged-env construction (`SubprocessEnv()`), which **both**
> `mod.New()` and `ingest.New()` consume. This centralizes env construction in the one
> package both subprocess paths already share (`ingest` imports `mod` for
> `RunSubprocess`), and matches the existing "main applies resolved config into the mod
> package" pattern (`mod.CmdTimeout`, `mod.AllowPrivateFetch`, `mod.MaxAssetSize` set in
> `main()` right before `ctx.Run()`).

Rejected alternatives:
- **B — registered config section via `store.RegisterConfig`:** that registry is keyed
  by backend *scheme* and strict-decodes into a typed struct; secrets are arbitrary
  keys, not a backend. Semantic misfit, and the masked-print path would special-case it
  anyway.
- **C — kong `map[string]string` flag on `Globals`:** kong map flags are CLI-oriented
  (`--secrets k=v`), leaking secrets onto the command line / into `--help`; the
  env-tag/masking story gets awkward.

### Components

**1. Parse (`main`, package `main`)**

- `parseSecrets(configData []byte) (map[string]string, error)` — `yaml.Unmarshal` into a
  small struct with a single `Secrets map[string]string` field tagged `yaml:"secrets"`.
  - Reject an **empty key** or a key **containing `=`** (either would corrupt the
    `KEY=VALUE` wire) → hard error, matching SRR's loud-on-bad-config philosophy.
  - Missing/absent section ⇒ `nil` map, no error.
- Stored in a package-level `var secrets map[string]string`, parsed right after
  `readConfig()` in `main()`.
- `main()` pushes it into `mod` in the existing config-apply block (next to
  `mod.CmdTimeout = …`): `mod.SetSecrets(secrets)`.

**2. Merge / precedence (`mod` package)**

- `var secrets map[string]string` (package-level) + `func SetSecrets(map[string]string)`.
- `func SubprocessEnv() []string`: overlays `secrets` onto `os.Environ()` keyed by env
  name (**secrets win**), deduped to one entry per key, sorted for determinism. When
  `secrets` is empty it returns `os.Environ()` unchanged (preserving today's behavior
  byte-for-byte). The explicit key-map merge (rather than appending and relying on Go
  `os/exec`'s dedup-keeps-last behavior) makes "secrets win" self-documenting and
  platform-independent.
- `mod.New()` and `ingest.New()` set their `env` field to `mod.SubprocessEnv()` instead
  of `os.Environ()`.

**3. Scope is satisfied by construction**

asset-process (`SRR_ASSET_PROCESS`) and asset-peek (`SRR_ASSET_PEEK`) run through
`mod.RunCommand` / `mod.RunCommandTimeout` → `runBounded(exec.CommandContext(...))`,
which **never sets `cmd.Env`** — the child inherits `srrb`'s real process environment,
which does not include the (yaml-only) secrets. Only `RunSubprocess` carries an `env`
param, fed by the two `New()` paths. So the ingest/mod-only scope needs **no extra
gating code** — touching only the two `New()` env fields is exactly the requested scope.

**4. `srr config` masking (`cmd_config.go`, package `main`)**

`cmd_config` reads the package-level `secrets` var directly (same process). Mask is a
fixed `"***"` literal.

- **No-arg** (`srr config`): after globals + backend sections, if `len(secrets) > 0`,
  print a trailing `secrets:` section, keys sorted, each line `  KEY=***`.
- **Section** (`srr config secrets`): print all keys masked (sorted).
- **Single key** (`srr config secrets.MY_TOKEN`): print `***` if the key exists; reuse
  the existing `unknown config key` error otherwise.
- Implemented as an isolated small map-print path (`secrets` is a map, not a struct, so
  it sidesteps the existing reflect-based `printFields`).

## Data flow

```
srr.yaml ─readConfig()─► configData ─parseSecrets()─► secrets (map[string]string, package main)
                                                          │
                                       mod.SetSecrets(secrets)  (main config-apply block)
                                                          │
                                                  mod.secrets (package mod)
                                                          │
                                          mod.SubprocessEnv()  = os.Environ() ⊕ secrets (secrets win)
                                              │                         │
                                        mod.New().env           ingest.New().env
                                              │                         │
                                   RunSubprocess(shell mod)   RunSubprocess(external ingest)
                                              │                         │
                                        cmd.Env = merged env  ───────────┘

cmd_config reads package-main `secrets` ──► masked print (KEY=***)
```

## Error handling

- Bad secret key (empty or contains `=`) → hard fatal at startup (config error), like
  other malformed-config failures.
- Absent `secrets:` section → no-op; `SubprocessEnv()` == `os.Environ()`.
- A secret colliding with an existing process-env var → secret wins (documented).

## Testing

- **`mod`** (`mod/main_test.go` / new `_test.go`):
  - `SubprocessEnv()` — merges os env + secrets; a secret **overrides** an ambient var;
    non-overlapping os vars still present; empty secrets ⇒ unchanged `os.Environ()`.
    (Use `t.Setenv` before `SetSecrets` to control the ambient var.)
  - Extend the external-mod protocol test to prove a configured secret reaches a shell
    mod's environment.
- **`ingest`** (`ingest/external_test.go`): extend `TestExternalFetcherEnvPassthrough` to
  set a secret that **overrides** an ambient `SRR_*` and assert the command sees the
  secret value (snapshot order: `SetSecrets` before `ingest.New()`).
- **`main`** (`main_test.go` or `cmd_config_test.go`): `parseSecrets` happy path; reject
  empty key; reject key containing `=`; absent section ⇒ nil.
- **`cmd_config`** (`cmd_config_test.go`): masked output for `srr config` (no-arg),
  `srr config secrets`, `srr config secrets.KEY`; unknown sub-key error.
- Full `make verify-be` (vet + gofmt + build + test + generate-check) green. No
  `format.gen.ts` change expected (this touches no data-contract atom).

## Docs

- **`backend/CLAUDE.md`** — document the `secrets:` section: shape, ingest/mod-only
  scope, secrets-win precedence, masked in `srr config`. Note the plaintext-at-rest
  caveat (`chmod 600 srr.yaml`).
- **`backend/README.md`** — where the external ingest/mod protocols already live: note
  that `secrets:` values are merged into the command environment.
- No root `CLAUDE.md` / data-contract change (backend-only operator config, not a wire
  format).

## Files touched (estimate)

| File | Change |
|---|---|
| `backend/main.go` | `parseSecrets`, `var secrets`, parse after `readConfig`, `mod.SetSecrets` in apply block |
| `backend/mod/main.go` | `var secrets`, `SetSecrets`, `SubprocessEnv`; `New().env = SubprocessEnv()` |
| `backend/ingest/main.go` | `New().env = mod.SubprocessEnv()` |
| `backend/cmd_config.go` | masked `secrets` print (no-arg / section / single-key) |
| `backend/mod/*_test.go`, `backend/ingest/external_test.go`, `backend/*_test.go` | tests above |
| `backend/CLAUDE.md`, `backend/README.md` | docs |
