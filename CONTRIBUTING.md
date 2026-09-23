# Contributing

SRR is a monorepo: `backend/` (Go CLI, the pack writer) and `frontend/` (TypeScript SPA, the reader plus the admin page), and a shared e2e contract suite in `frontend/e2e/`.

## Before you open a PR

```bash
make verify        # lint + format + tests + builds + the e2e contract layer
make test-browser  # the Puppeteer layer CI also requires
```

- The writer↔reader data contract is generated, never hand-mirrored: change the Go declarations and run `make generate`; `make verify` fails if `format.gen.ts` is stale.
- The format specs live in `docs/` (`MANIFEST-SPEC.md` first) — read them before touching the commit path, object names, or GC.
- Commit messages follow the conventional-prefix style you see in `git log`.

## Scope

Bug reports and focused fixes are welcome. For format or architecture changes, open an issue first — the data contract carries invariants (chron permanence, write-once names) that a PR must not break, and the specs explain why.
