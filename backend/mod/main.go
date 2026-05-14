package mod

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

var registry = map[string]func() func(*RawItem) error{}

// Register registers a built-in processor available as "#name".
func Register(name string, init func() func(*RawItem) error) {
	if !strings.HasPrefix(name, "#") {
		name = "#" + name
	}
	registry[name] = init
}

type Module struct {
	processors map[string]func(*RawItem) error
	env        []string
}

func New() *Module {
	m := &Module{
		processors: make(map[string]func(*RawItem) error, len(registry)),
		env:        os.Environ(),
	}
	for name, init := range registry {
		m.processors[name] = init()
	}
	return m
}

func (o *Module) Process(ctx context.Context, args string, i *RawItem) error {
	if fn, ok := o.processors[args]; ok {
		return fn(i)
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

	// Preserve the typed Raw payload across the JSON round-trip — Unmarshal
	// would otherwise decode it into map[string]any, breaking type-asserts
	// in built-ins that run after a shell module (e.g. #youtube).
	saved := i.Raw
	if err := json.Unmarshal(out.buf.Bytes(), i); err != nil {
		return err
	}
	i.Raw = saved
	return nil
}
