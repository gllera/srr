#!/bin/bash
FILE_PATH=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
  *.ts|*.css|*.html) cd "$CLAUDE_PROJECT_DIR/frontend" && npx prettier --write "$FILE_PATH" >/dev/null 2>&1 ;;
  *.go)
    gofmt -w "$FILE_PATH" || exit 0
    # Run go vet on the whole backend module so cross-file issues are caught.
    # Surface failures to Claude via stderr+exit 2; gofmt already succeeded so
    # the file is saved either way.
    vet_out=$(cd "$CLAUDE_PROJECT_DIR/backend" && go vet ./... 2>&1)
    if [ -n "$vet_out" ]; then
      echo "go vet:" >&2
      echo "$vet_out" >&2
      exit 2
    fi
    ;;
esac
