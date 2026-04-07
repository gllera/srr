#!/bin/bash
# PreToolUse hook for Edit|Write|MultiEdit.
# Refuses to touch files under packs/ — that's live dev data served by the
# Parcel dev server (npm run dev → npx serve --cors ../packs). A binary edit
# of a .gz pack file is unrecoverable.
#
# Wired up via .claude/settings.json:
#   {
#     "hooks": {
#       "PreToolUse": [{
#         "matcher": "Edit|Write|MultiEdit",
#         "hooks": [{
#           "type": "command",
#           "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-edit-guard.sh"
#         }]
#       }]
#     }
#   }
#
# Exit codes:
#   0 — allow
#   2 — deny (stderr is shown to Claude as feedback)

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

[ -z "$file_path" ] && exit 0

# Match anywhere a packs/ path segment appears: absolute paths, relative paths,
# under repo root, etc. The packs/ directory is the only one we guard.
case "$file_path" in
  */packs/*|packs/*)
    echo "Refusing to edit '$file_path': files under packs/ are live dev data and must not be modified by tool calls. If you really need to change this file, do it manually outside Claude." >&2
    exit 2
    ;;
esac

exit 0
