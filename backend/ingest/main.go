// Package ingest abstracts the I/O+parse step that turns a source URL
// into a slice of mod.RawItems. The built-in fetcher (#feed) registers
// itself at init(); any other name is treated as a shell command per the
// external-fetcher wire protocol (see Fetcher.Fetch).
//
// A FetchFunc owns I/O and parsing only — dedup, watermarking, pipeline
// modules, and storage all stay in the caller (Source.fetch) and operate
// uniformly on the items each fetcher returns.
package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"srrb/mod"
)

// Request is what a FetchFunc receives. ETag / LastModified are advisory;
// a FetchFunc that doesn't understand them simply returns Items every
// call and lets the caller's GUID-based dedup handle re-presented items.
// JSON tags double as the external-fetcher stdin wire schema.
type Request struct {
	URL          string `json:"url"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	MaxSize      int    `json:"max_size"`
	// AssetDir is the fetcher's persistent download cache, one directory shared by
	// every feed this run: the caller creates it (and never deletes it) and, for
	// an external strategy, the command runs in it (its working directory, set as
	// cmd.Dir below) — a built-in fetcher may read this path and download into it
	// just the same. The fetcher stashes files under a layout it chooses
	// (namespacing as needed, since feeds share the dir) and checks it to skip
	// re-downloading. To self-host a file, the fetcher references it in item
	// content as "#<relative-path>" (e.g. "#/photo.jpg"); the caller's
	// end-of-pipeline upload step (main.Feed.fetch) uploads each referenced
	// file to the store and rewrites the reference to the final key. Empty (and
	// the working directory left unchanged) when self-hosting is disabled (no
	// store wired, e.g. preview).
	AssetDir string `json:"asset_dir,omitempty"`
}

// Result is what a FetchFunc returns. NotModified short-circuits the
// caller's processing (Items are inspected only when false). ETag /
// LastModified, when non-empty, persist on the Source for the next call.
// JSON tags double as the external-fetcher stdout wire schema.
type Result struct {
	NotModified  bool           `json:"not_modified,omitempty"`
	ETag         string         `json:"etag,omitempty"`
	LastModified string         `json:"last_modified,omitempty"`
	Items        []*mod.RawItem `json:"items,omitempty"`
	// ResolvedURL is set when the #feed fetcher auto-discovered a feed URL
	// from an HTML page and refetched from that URL. The caller should persist
	// ch.URL = ResolvedURL to avoid re-discovering on every subsequent fetch.
	// omitempty keeps the external-fetcher wire protocol unaffected.
	ResolvedURL string `json:"resolved_url,omitempty"`
}

// userAgent is the User-Agent header value sent by built-in HTTP-based
// fetchers. Kept generic — feed publishers expect a fixed identifier per
// reader, not a per-version string.
const userAgent = "SRR"

// readBody streams body into the caller's per-worker buf via io.ReadFull
// and maps the three meaningful outcomes: oversize (entire buf filled),
// empty body, and the expected short-read. what is the source noun used
// in the size/empty error message (e.g. "feed").
func readBody(body io.Reader, buf []byte, what string) ([]byte, error) {
	n, err := io.ReadFull(body, buf)
	if err == nil {
		return nil, fmt.Errorf("%s bigger than %d bytes", what, cap(buf)-1)
	}
	if errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("empty response from %s", what)
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	return buf[:n], nil
}

// FetchFunc fetches a single URL into a Result. Built-in fetchers register
// one of these directly (Register) at init; the built-ins are stateless, so
// there is no per-instance state to build.
//
// The shared *http.Client is provided for HTTP-based built-ins; external
// fetchers ignore it. The shared buf is the caller's per-worker read
// buffer — built-ins should reuse it, external fetchers leave it alone.
type FetchFunc func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error)

var registry = map[string]FetchFunc{}

// Register registers a built-in fetcher available as "#name". Names
// without a leading "#" get one prepended so init() calls can pass either
// form.
func Register(name string, fn FetchFunc) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	registry[name] = fn
}

// Builtin is the token of the zero-config built-in fetcher (registered as
// "feed" → "#feed"). It is the final fallback of Select and the value callers
// compare against to decide whether subscribe-time discovery applies.
const Builtin = "#feed"

// Select applies the caller's precedence rule: feed > global default
// > built-in "#feed". Empty strings fall through.
func Select(feedFetcher, globalFetcher string) string {
	for _, name := range []string{feedFetcher, globalFetcher} {
		if name != "" {
			return name
		}
	}
	return Builtin
}

// Fetcher is the dispatcher. New() builds one over the registered built-ins;
// Fetch routes per-call by name.
type Fetcher struct {
	fetchers map[string]FetchFunc
	env      []string
}

// New builds a Fetcher backed by the registered built-ins. The built-in
// FetchFuncs are stateless, so the registry map is shared rather than copied.
func New() *Fetcher {
	return &Fetcher{
		fetchers: registry,
		env:      os.Environ(),
	}
}

// Fetch dispatches by name. A built-in registered as "#name" runs its
// FetchFunc; any other args string is executed as a shell command per
// the external-fetcher wire protocol — JSON-encoded Request on stdin,
// JSON Result on stdout, stderr passthrough. Items on the wire are
// mod.RawItem records: `guid` is the FNV-32a hash (uint32) of any stable
// per-item string (computed by the external fetcher to match the dedup
// contract used by built-ins); `published` is RFC3339 or null/absent for
// dateless items.
//
// A non-zero exit code, empty stdout, or output over the subprocess output cap
// is a hard error (fails just this feed's fetch). The author-facing spec and a
// reference implementation live in README.md (Ingest Strategies).
func (f *Fetcher) Fetch(ctx context.Context, args string, client *http.Client, buf []byte, req Request) (Result, error) {
	if fn, ok := f.fetchers[args]; ok {
		return fn(ctx, client, buf, req)
	}

	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(req); err != nil {
		return Result{}, fmt.Errorf("encode fetcher request: %w", err)
	}

	// Bound the command so a hang can't wedge the worker forever — the fetch
	// context has no deadline of its own (see mod.SubprocessTimeout). The
	// caller's shared download cache (Request.AssetDir) doubles as the command's
	// working directory, so it can stash and reference files with relative paths.
	raw, err := mod.RunSubprocess(ctx, args, f.env, req.AssetDir, &body)
	if err != nil {
		return Result{}, fmt.Errorf("fetcher command %q: %w", args, err)
	}

	// Empty stdout is a protocol violation, not a no-op: a fetcher that has
	// nothing to report must still say so explicitly ({"items":[]} or
	// {"not_modified":true}). Reporting it here beats letting json.Unmarshal
	// fail on "" with an opaque "unexpected end of JSON input".
	if len(raw) == 0 {
		return Result{}, fmt.Errorf("fetcher command %q produced no output", args)
	}

	var resp Result
	if err := json.Unmarshal(raw, &resp); err != nil {
		return Result{}, fmt.Errorf("decode fetcher response: %w", err)
	}
	return resp, nil
}
