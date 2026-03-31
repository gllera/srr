---
name: verify
description: Run all project checks in sequence (lint, format, tests, build) and stop on first failure. Use before committing or to confirm the project is clean.
---

Run all project checks. Stop on first failure.

## Steps

Run `make verify-fe` and `make verify-be` **in parallel** (two separate shell sessions). Each runs its pipeline sequentially and stops on first failure.

If any step in either track fails, stop and report the failure clearly with the relevant output.

If all steps pass, confirm that everything is clean in a single summary line.
