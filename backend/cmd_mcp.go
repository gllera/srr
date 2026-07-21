package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// McpCmd serves the same tool set as serve's /mcp endpoint over stdio — the
// transport a locally-spawned client (`claude mcp add srr -- srr mcp`) uses,
// where the client owns the process lifetime and speaks JSON-RPC on the pipe.
//
// STDOUT DISCIPLINE (the invariant this command depends on): stdout IS the
// protocol stream here, so nothing on the tool path may write to it. Verified
// by construction rather than by convention:
//   - slog goes to stderr — main() routes the default log handler through
//     `status` (progress.go), which wraps os.Stderr;
//   - the fetch status line is stderr-only and no-ops entirely when stderr is
//     not a terminal (statusLine.tty), which it never is under a client's pipe;
//   - `printJSON` and the CLI banners live in command Run() methods that the
//     tool handlers never call (they wrap the value-returning helpers instead —
//     see mcp.go);
//   - external ingest/mod/asset commands have their stdout CAPTURED
//     (mod.RunSubprocess / mod.RunCommandTimeout) and only their stderr is
//     passed through;
//   - the MCP SDK's own logger defaults to slog.DiscardHandler.
//
// A tool handler must therefore never call printJSON or fmt.Print*.
type McpCmd struct{}

func (o *McpCmd) Run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := newMCPServer().Run(ctx, &mcp.StdioTransport{})
	// Run returns ctx.Err() when the signal context fires: that is the client
	// (or the operator) asking the session to end, not a failure — reporting it
	// would exit non-zero on every clean Ctrl-C/SIGTERM.
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
