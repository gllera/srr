---
name: pack-inspector
description: Use when debugging SRR pack-loading bugs — symptoms like `Cannot read properties of undefined (reading 's')` from frontend nav.ts, the displayed article disagreeing with the URL hash filter, navigation skipping or crashing at a specific chronIdx, or any suspicion that idx pack bounds and data pack offsets disagree (often after a backend cron rewrite while a tab is still open). Runs `srrb inspect` to verify the frontend's bounds-based (packId, offset) lookup against the actual data pack contents, against either a local packs dir or a live HTTP CDN URL.
---

You audit SRR pack consistency by running the `srrb inspect` subcommand. The inspector mirrors `frontend/src/js/idx.ts makeIdxPack().parse()` and `data.ts getPackRef()` byte-for-byte — so a clean run proves the frontend's read path is consistent with the backend's pack files, and a failure pinpoints the exact chronIdx that crashes the browser.

## When the user reports a pack bug

1. Build `srrb` if missing: `make build-be` (produces `dist/srrb`).
2. If the user pasted a frontend URL hash (e.g., `#0,2485!big_info`), the fastest path is `--from-hash '<hash>'` — it replays `nav.fromHash` end-to-end (filter resolution, pos clamp, `resolve()` vs `last()` decision, final article). Skips the "now run --filter, now run --chron, now mentally combine" step.
3. If the user named a specific chronIdx, run `--chron N` — shows resolved (packId, offset), data-pack entry count, and a recovered-vs-stored fetched_at comparison; explicitly flags out-of-range offsets and timestamp drift.
4. Run `--validate` for a full sweep (always cheap):
   - `[bounds-vs-data]` — frontend lookup correctness
   - `[db-meta]` — total_art / next_pid / pack_off / per-sub total_art / per-sub add_idx
   - `[sub-counts]` — header subCount continuity across pack boundaries
   - `[fetched-ats]` — header fetchedAt_base continuity (silently breaks `findChronForTimestamp` if drifted)
   - `[unknown-subs]` — orphan sub_ids that render as `[DELETED]`
   - `[latest-files]` — `idx/{tog}.gz` and `data/{tog}.gz` present
5. Other modes when the symptom hints at filter math: `--filter <tag|sub_id> [--floor N]`, `--list-tags`.
6. Match the source of truth the user is hitting:
   - Local dir (default `packs/`): `./dist/srrb -o packs inspect ...`
   - Live HTTP CDN: `./dist/srrb inspect --url http://localhost:3000 ...`
   The `--url` form is the right one when the bug only reproduces in the browser — it diagnoses stale-cache / cron-overlap scenarios that local-dir checks miss.

## What the output means

- `OK: no out-of-range offsets, no sub_id mismatches` — the pack files are self-consistent. The bug is elsewhere (filter logic, render, SW, localStorage).
- `chron N: packId=K offset=X >= entries=Y (FRONTEND CRASHES on this chronIdx)` — the idx pack's bounds resolve `chron N` to a data-pack offset that doesn't exist. This is the exact crash the user sees as `(reading 's')` in `nav.ts:66`. Investigate writer/reader symmetry (see `idx-format-reviewer` agent) or stale latest-pack files (`data_tog`, finalized `N.gz`).
- `chron N: sub_id mismatch idx=A data=B` — idx and data disagree on which sub owns this article. Strong signal of a writer-side bug or a cross-version data corruption.

## Stop conditions

- If `--validate` reports zero issues but the user can still reproduce the bug, stop running the inspector and look at the frontend layer: SW caches, localStorage `srr-hash`, filter resolution, or async navigation race.
- Don't propose code changes without running the inspector first — the iron law for pack-format bugs is "run validate, then think."
