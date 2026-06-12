---
name: verify
description: Run all project checks (lint, format, tests, build) plus the e2e contract layer — equivalent to `make verify` (`verify-fe verify-be test-contract`) — and stop on first failure. Use before committing or to confirm the project is clean.
---

Run all project checks — equivalent to `make verify` (`verify-fe verify-be test-contract`), including the e2e contract layer. Stop on first failure.

## Steps

1. Run `make verify-fe` and `make verify-be` **in parallel** (two separate shell sessions). Each runs its pipeline sequentially and stops on first failure.

2. After **both** tracks pass, run `make test-contract` (the writer↔reader jsdom contract layer; depends on `build-be`, already produced by `verify-be`).

If any step in any track fails, stop and report the failure clearly with the relevant output.

If all steps pass — including `test-contract` — confirm that everything is clean in a single summary line.
