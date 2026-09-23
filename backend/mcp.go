package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This file owns the MCP server registry; the tool handlers themselves live in
// mcp_tools.go. MCP is served over stdio only (`srr mcp`, cmd_mcp.go) — there
// is no HTTP transport.
//
// STDOUT DISCIPLINE: nothing under the MCP surface may write to os.Stdout.
// The stdio transport (`srr mcp`, cmd_mcp.go) speaks JSON-RPC on stdout, so a
// stray printJSON / fmt.Print* from a tool handler would corrupt the protocol
// stream mid-session.
// Enforced by construction: every handler returns a typed value the SDK
// marshals, and every wrapped helper (listArticles, buildOverview,
// renderPreview, previewFetch, saveFeed, runFetch) is a value-returning
// function — the printing lives in the CLI Run() methods, which the tool layer
// never calls. Logging stays on slog (stderr).

// hintPtr is the *bool helper the MCP annotations need: DestructiveHint and
// OpenWorldHint are POINTERS that default to TRUE when nil, so a read-only or
// closed-world tool has to say `false` out loud or it is silently mislabelled
// to every client. (Named for the hints rather than the type: `boolPtr` is
// already taken by a test helper in this package.)
func hintPtr(b bool) *bool { return &b }

// newMCPServer builds the srr MCP server with every tool registered. The
// version is the same ldflags-stamped `version` the CLI and the admin GUI
// report, so a client can tell which binary it is talking to.
func newMCPServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{
		Name:    "srr",
		Title:   "SRR — Static RSS Reader",
		Version: version,
	}, nil)
	addMCPTools(s)
	return s
}

// msgMCPStoreBusy mirrors the admin API's 409 contract (msgLockContention) in
// the vocabulary a tool caller can act on: the store lock is held by another
// srr process — almost always the fetch loop mid-cycle — and the right move is
// to retry, not to change the arguments.
const msgMCPStoreBusy = "store busy: fetch cycle in progress; retry shortly"

// mcpToolErr maps an internal error to the message a tool call returns.
// Structural classification only (same discipline as writeErr): lock
// contention and cancellation get an operator-grade rewrite, everything else
// passes through — validation messages from normalizeFeed/listArticles/the
// ingest engine are already written for a human and need no translation.
func mcpToolErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrExist) {
		return errors.New(msgMCPStoreBusy)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("cancelled: %w", err)
	}
	return err
}
