package mod

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

// maxSubprocessOutput caps the bytes buffered from an external module's stdout.
// Above this, the writer returns an error which propagates as a broken pipe to
// the subprocess. Defense-in-depth against runaway output OOM'ing the process.
const maxSubprocessOutput = 64 << 20

type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.limit {
		return 0, fmt.Errorf("subprocess output exceeds %d bytes", c.limit)
	}
	return c.buf.Write(p)
}

type RawItem struct {
	GUID      uint32     `json:"guid"`
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Link      string     `json:"link"`
	Published *time.Time `json:"published"`
	Raw       any        `json:"raw"`
}

// RawField is one element of a parsed feed entry: text content, attributes,
// and any nested children. JSON keys are short ("@", "$", "+") so external
// shell modules see a compact form.
type RawField struct {
	Txt  string            `json:"@,omitempty"`
	Attr map[string]string `json:"$,omitempty"`
	Chld RawFeedItem       `json:"+,omitempty"`
}

// RawFeedItem is the parsed children of a feed <item>/<entry>, keyed by
// element local name. Each name maps to all occurrences in document order.
type RawFeedItem map[string][]RawField

// Text returns the first non-empty text value among the given child names.
func (r RawFeedItem) Text(names ...string) string {
	for _, name := range names {
		for _, f := range r[name] {
			if f.Txt != "" {
				return f.Txt
			}
		}
	}
	return ""
}

// Assets lets a module download an object by URL and stream it into the SRR
// store, returning the RELATIVE store key to reference it by.
type Assets interface {
	// Fetch GETs srcURL and streams the body into the store under a URL-hash
	// key, returning the relative key (e.g. "assets/ab/cd1234.jpg"). On any
	// failure returns ("", err); callers keep the original URL.
	Fetch(ctx context.Context, srcURL string) (key string, err error)
}

// Processor is a built-in pipeline step. Params carries the key=value options
// parsed from the step's pipeline token (e.g. "timeout=30s" in
// "#readability timeout=30s"); steps that take no options ignore it.
type Processor func(context.Context, Params, *RawItem) error

var registry = map[string]func(Assets) Processor{}

// Register registers a built-in processor available as "#name". The init
// factory receives the run's Assets capability (may be nil when no store is
// wired, e.g. preview/tests) and runs once per New().
func Register(name string, init func(Assets) Processor) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	registry[name] = init
}

type Module struct {
	processors map[string]Processor
	env        []string
}

// New builds a Module with every registered built-in instantiated once.
// assets is the download capability passed to each built-in factory; pass
// nil to disable downloads (built-ins degrade to a no-op for that feature).
func New(assets Assets) *Module {
	m := &Module{
		processors: make(map[string]Processor, len(registry)),
		env:        os.Environ(),
	}
	for name, init := range registry {
		m.processors[name] = init(assets)
	}
	return m
}

func (o *Module) Process(ctx context.Context, args string, i *RawItem) error {
	// A built-in token is "#name [key=value ...]": the first whitespace field
	// names the step, the rest are its parameters. Only when that first field
	// is a registered built-in do we strip params and dispatch internally;
	// anything else (incl. shell commands whose first word merely contains
	// spaces or "=") falls through to /bin/sh -c with the original args.
	if fields := strings.Fields(args); len(fields) > 0 {
		if fn, ok := o.processors[fields[0]]; ok {
			params, err := parseParams(fields[1:])
			if err != nil {
				return err
			}
			return fn(ctx, params, i)
		}
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(i); err != nil {
		return err
	}

	out := &cappedBuffer{limit: maxSubprocessOutput}

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", args)
	cmd.Stdin = &buf
	cmd.Stdout = out
	cmd.Stderr = os.Stderr
	cmd.Env = o.env

	if err := cmd.Run(); err != nil {
		return err
	}

	// Empty/whitespace stdout means the shell step chose to emit nothing (a
	// `true`, a filter that dropped the line, a conditional no-op). Treat it as
	// "leave the item unchanged" rather than feeding "" to json.Unmarshal —
	// which errors with "unexpected end of JSON input" and (per feed.go) would
	// drop the item.
	if strings.TrimSpace(out.buf.String()) == "" {
		return nil
	}

	// Preserve the typed Raw payload across the JSON round-trip — Unmarshal
	// would otherwise decode it into map[string]any, breaking type-asserts
	// in built-ins that run after a shell module.
	saved := i.Raw
	if err := json.Unmarshal(out.buf.Bytes(), i); err != nil {
		return err
	}
	i.Raw = saved
	return nil
}

// IsBuiltin reports whether token's first whitespace field names a registered
// built-in module (e.g. "#sanitize" or "#readability timeout=30s"). Used by the
// CLI to reject misspelled "#"-tokens before they are stored.
func IsBuiltin(token string) bool {
	fields := strings.Fields(token)
	if len(fields) == 0 {
		return false
	}
	_, ok := registry[fields[0]]
	return ok
}

// Builtins returns the registered built-in module names (e.g. "#sanitize"),
// sorted, for help and validation error messages.
func Builtins() []string {
	out := make([]string, 0, len(registry))
	for name := range registry {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// Validate checks an already-resolved pipeline before the per-item fetch loop,
// so a misconfigured pipe fails loudly (a channel-level error) instead of
// silently dropping every item. For each step: an empty step or an unknown
// "#"-prefixed token (incl. a stray "#base" or "#base key=val") is rejected; a
// known built-in is run once against a throwaway item to surface parameter
// errors (bad value, unknown key); external shell steps are not executed here.
func (o *Module) Validate(ctx context.Context, pipeline []string) error {
	sentinel := &RawItem{}
	for _, step := range pipeline {
		fields := strings.Fields(step)
		if len(fields) == 0 {
			return fmt.Errorf("empty pipeline step")
		}
		fn, ok := o.processors[fields[0]]
		if !ok {
			if strings.HasPrefix(fields[0], "#") {
				return fmt.Errorf("unknown built-in module %q", fields[0])
			}
			continue // external shell command: not validated here
		}
		params, err := parseParams(fields[1:])
		if err != nil {
			return fmt.Errorf("%s: %w", fields[0], err)
		}
		if err := fn(ctx, params, sentinel); err != nil {
			return fmt.Errorf("%s: %w", fields[0], err)
		}
	}
	return nil
}
