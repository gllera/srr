---
name: update-claude-md
description: "Update CLAUDE.md files (and the .claude/agents/ definitions that embed the same facts) to reflect the current state of the codebase. Use after code changes to prevent documentation drift. This includes changes to project architecture, commands, key patterns, package structure, dependencies, or build processes. Should be used proactively after significant code modifications."
model: sonnet
color: pink
---

Update CLAUDE.md files to reflect the current state of the codebase. There are three files, plus one spec the root defers to:

- **Root `CLAUDE.md`** — canonical data contract (db.gz, pack format, CDN layout)
- **`backend/CLAUDE.md`** — backend-specific (references root for shared format)
- **`frontend/CLAUDE.md`** — frontend-specific (references root for shared format)
- **`docs/DELTA-TAIL-SPEC.md`** — the delta-segment tail spec (read it when the tail write path or the pack↔delta seam changed; the root contract summarizes it and must not contradict it)

## Process

1. Read all three `CLAUDE.md` files
2. Read key source files: `frontend/src/js/types.d.ts`, `frontend/src/js/data.ts`, `frontend/src/js/nav.ts`, `frontend/src/js/app.ts`, `backend/db.go`, `backend/db_pack.go`, `backend/db_meta.go`, `backend/feed.go`, `backend/seen.go`, `backend/store/main.go`
3. Glob for undocumented files: `backend/cmd_*.go`, `backend/*.go`, `backend/store/*.go`, `backend/mod/*.go`, `backend/ingest/*.go`, `frontend/src/js/*.ts`
4. Compare each section against actual code and fix stale content
5. Sweep `.claude/agents/*.md` for the same drift: agent definitions embed format facts (pack naming, interface shapes, sanitizer allowlists, test patterns) that rot with the code exactly like CLAUDE.md does. Fix stale claims; prefer symbolic references over pinned line numbers and inventories.

## Rules

- Keep descriptions concise and factual — match the existing terse style
- Only modify sections that are actually wrong or incomplete
- Preserve existing document structure, heading hierarchy, and writing style
- Root owns the canonical data contract; subproject files reference root and add only project-specific details
- Do not add new top-level sections without good reason
- Do not add speculative content — only document what you can verify in code
