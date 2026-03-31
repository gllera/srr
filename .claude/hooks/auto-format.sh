#!/bin/bash
FILE_PATH=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
  *.ts|*.css|*.html) cd "$CLAUDE_PROJECT_DIR/frontend" && npx prettier --write "$FILE_PATH" >/dev/null 2>&1 ;;
  *.go)              gofmt -w "$FILE_PATH" ;;
esac
