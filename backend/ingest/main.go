// Package ingest abstracts the I/O+parse step that turns a source URL
// into a slice of mod.RawItems. Built-in fetchers (#rss, #telegram)
// register themselves at init(); any other name is treated as a shell
// command per the external-fetcher wire protocol (see Fetcher.Fetch).
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
	"os/exec"
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
}

// userAgent is the User-Agent header value sent by built-in HTTP-based
// fetchers. Kept generic — feed publishers expect a fixed identifier per
// reader, not a per-version string.
const userAgent = "SRR"

// readBody streams body into the caller's per-worker buf via io.ReadFull
// and maps the three meaningful outcomes: oversize (entire buf filled),
// empty body, and the expected short-read. what is the source noun used
// in the size/empty error message ("subscription file", "telegram page").
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

// FetchFunc fetches a single URL into a Result. Built-in fetchers
// register a factory that returns one of these; the factory is called
// once per Fetcher (per New()) so it may capture per-instance state.
//
// The shared *http.Client is provided for HTTP-based built-ins; external
// fetchers ignore it. The shared buf is the caller's per-worker read
// buffer — built-ins should reuse it, external fetchers leave it alone.
type FetchFunc func(ctx context.Context, client *http.Client, buf []byte, req Request) (Result, error)

var registry = map[string]func() FetchFunc{}

// Register registers a built-in fetcher available as "#name". Names
// without a leading "#" get one prepended so init() calls can pass either
// form.
func Register(name string, init func() FetchFunc) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	registry[name] = init
}

// Select applies the caller's precedence rule: source > subscription >
// global default > built-in "#rss". Empty strings fall through.
func Select(sourceFetcher, subFetcher, globalFetcher string) string {
	for _, name := range []string{sourceFetcher, subFetcher, globalFetcher} {
		if name != "" {
			return name
		}
	}
	return "#rss"
}

// Fetcher is the dispatcher. New() builds one with every registered
// built-in instantiated once; Fetch routes per-call by name.
type Fetcher struct {
	fetchers map[string]FetchFunc
	env      []string
}

func New() *Fetcher {
	f := &Fetcher{
		fetchers: make(map[string]FetchFunc, len(registry)),
		env:      os.Environ(),
	}
	for name, init := range registry {
		f.fetchers[name] = init()
	}
	return f
}

// Fetch dispatches by name. A built-in registered as "#name" runs its
// FetchFunc; any other args string is executed as a shell command per
// the external-fetcher wire protocol — JSON-encoded Request on stdin,
// JSON Result on stdout, stderr passthrough. Items on the wire are
// mod.RawItem records: `guid` is the FNV-32a hash (uint32) of any stable
// per-item string (computed by the external fetcher to match the dedup
// contract used by built-ins); `published` is RFC3339 or null/absent for
// dateless items.
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

	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", args)
	cmd.Stdin = &body
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	cmd.Env = f.env
	if err := cmd.Run(); err != nil {
		return Result{}, fmt.Errorf("fetcher command %q: %w", args, err)
	}

	var resp Result
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		return Result{}, fmt.Errorf("decode fetcher response: %w", err)
	}
	return resp, nil
}
