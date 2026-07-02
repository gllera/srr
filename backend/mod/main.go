package mod

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
)

// maxSubprocessOutput caps the bytes buffered from an external command's stdout
// (a built-in module's shell step or an ingest fetcher). Above this, the writer
// returns an error which propagates as a broken pipe to the subprocess.
// Defense-in-depth against runaway output OOM'ing the process. An internal
// detail of RunSubprocess, which both the module and ingest paths run through.
const maxSubprocessOutput = 64 << 20

// cappedBuffer buffers subprocess output up to limit bytes and fails the write
// that would exceed it, rather than growing unbounded. It backs the capped
// stdout in RunSubprocess.
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

// stderrTailBytes bounds the stderr captured from an asset command (see
// RunCommandTimeout) for failure diagnostics; stderrTailLines is how many of
// its trailing lines are folded into the returned error.
const (
	stderrTailBytes = 4 << 10
	stderrTailLines = 8
)

// tailBuffer keeps the most recent limit bytes written and never fails a
// write, so a chatty subprocess can narrate progress on stderr without
// OOM'ing the worker or getting a broken pipe mid-run.
type tailBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.limit {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-t.limit:]...)
	}
	return len(p), nil
}

// Tail renders the captured stderr for an error message: CR progress rewrites
// count as line breaks, blank lines are dropped, and only the last
// stderrTailLines survive (error text clusters at the end; earlier bytes are
// usually progress spam), joined single-line so it embeds in a log attr.
func (t *tailBuffer) Tail() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var lines []string
	for _, l := range strings.FieldsFunc(string(t.buf), func(r rune) bool { return r == '\n' || r == '\r' }) {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > stderrTailLines {
		lines = lines[len(lines)-stderrTailLines:]
	}
	return strings.Join(lines, "; ")
}

// CmdTimeout overrides the external-command timeout when > 0. main sets it from
// the resolved --cmd-timeout / SRR_CMD_TIMEOUT global after parsing; a zero
// value (e.g. when mod is used directly in tests) falls back to
// defaultCmdTimeout.
var CmdTimeout time.Duration

const defaultCmdTimeout = 5 * time.Minute

// SubprocessTimeout bounds a single external (shell) command invocation so a
// command that blocks forever — waiting on stdin, sleeping, trapping SIGPIPE
// after the output cap fires — can't wedge a fetch worker for the life of the
// process. The fetch context carries no deadline (it cancels only on
// SIGINT/SIGTERM), so without this an external module or ingest command hang is
// unbounded. Generous default; override with the --cmd-timeout flag /
// SRR_CMD_TIMEOUT env. Shared with the ingest package, whose external-fetcher
// exec has the same exposure.
func SubprocessTimeout() time.Duration {
	if CmdTimeout > 0 {
		return CmdTimeout
	}
	return defaultCmdTimeout
}

// subprocessWaitDelay is the grace period os/exec gives a subprocess to drain
// its pipe after the context is cancelled (or the command exits while a
// backgrounded grandchild still holds the inherited stdout open). Without it,
// cmd.Run() would block until the grandchild exits, ignoring the timeout and
// returning err=nil. This is a package-level var (not a const) so tests can
// lower it without affecting the production default.
var subprocessWaitDelay = 5 * time.Second

// RunSubprocess runs `/bin/sh -c args` with the given env and working directory
// (dir == "" inherits the process cwd), feeding stdin and capturing stdout
// capped at MaxSubprocessOutput. The command is bounded by SubprocessTimeout so
// a hang can't wedge the worker forever. Returns the whitespace-trimmed stdout
// bytes; the caller decides what an empty result means (a no-op vs an error) and
// how to wrap a run failure. Shared by the built-in shell-module path and the
// ingest external-fetcher path, which run the same exec with different policies.
//
// subprocessWaitDelay ensures the bound holds even when a shell mod backgrounds
// a child process that inherits stdout: without it, cmd.Run() would block until
// the grandchild exits (keeping the pipe open), ignoring the timeout and
// returning err=nil. With WaitDelay, os/exec force-closes the pipe after
// cancellation and cmd.Run() returns promptly with a non-nil error.
func RunSubprocess(ctx context.Context, args string, env []string, dir string, stdin io.Reader) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, SubprocessTimeout())
	defer cancel()
	cmd := exec.CommandContext(cctx, "/bin/sh", "-c", args)
	cmd.Stdin = stdin
	cmd.Env = env
	cmd.Dir = dir
	out, err := runBounded(cmd)
	if err != nil {
		return nil, err
	}
	return bytes.TrimSpace(out), nil
}

// RunCommandTimeout runs argv (name plus args) under the same hardened bounds as
// RunSubprocess — subprocessWaitDelay and a maxSubprocessOutput-capped stdout —
// but via direct exec rather than /bin/sh, WITHOUT trimming (stdout may be binary,
// e.g. a transcoded asset), and with an explicit per-invocation timeout instead of
// the shared SubprocessTimeout. The asset-process command (assets.go) uses this
// with its own much longer bound (--asset-process-timeout), since media
// transcoding can outlast a feed/ingest command. A timeout <= 0 means UNLIMITED:
// no deadline is added and the command runs until it exits or ctx is cancelled
// (SIGINT/SIGTERM) — the WaitDelay + output-cap hardening still applies.
//
// Unlike RunSubprocess (whose external ingest/mod commands own the passthrough
// stderr as their documented log channel), stderr here is CAPTURED, not leaked:
// asset commands narrate progress on stderr (a transcoder's tty progress bar),
// and with many running in parallel that garbles srr's own output. On failure
// the tail of the captured stderr is folded into the returned error so the
// caller's warn line carries the diagnostic; on success it is discarded.
func RunCommandTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, name, args...)
	tail := &tailBuffer{limit: stderrTailBytes}
	cmd.Stderr = tail
	out, err := runBounded(cmd)
	if err != nil {
		if t := tail.Tail(); t != "" {
			return nil, fmt.Errorf("%w; stderr: %s", err, t)
		}
		return nil, err
	}
	return out, nil
}

// runBounded is the shared hardened exec core: stdout captured into a
// maxSubprocessOutput-capped buffer, stderr passed through unless the caller
// already set one (RunCommandTimeout captures it), and WaitDelay set so a
// backgrounded grandchild can't hold the pipe open past the deadline. The
// caller builds cmd from a SubprocessTimeout-bounded context and sets any
// stdin/env/dir.
func runBounded(cmd *exec.Cmd) ([]byte, error) {
	out := &cappedBuffer{limit: maxSubprocessOutput}
	cmd.Stdout = out
	if cmd.Stderr == nil {
		cmd.Stderr = os.Stderr
	}
	cmd.WaitDelay = subprocessWaitDelay
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.buf.Bytes(), nil
}

type RawItem struct {
	GUID      uint32     `json:"guid"`
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Link      string     `json:"link"`
	Published *time.Time `json:"published"`
	Raw       any        `json:"raw"`
	// Drop, when true, signals that this item should be silently discarded by
	// the pipeline. Set by #filter or by an external mod that emits
	// {"drop":true}. Dropped items are never written to the packs but their
	// GUID is retained in the feed's dedup boundary so they are not
	// re-evaluated on subsequent fetches. Drop is NOT a pipeline error.
	Drop bool `json:"drop,omitempty"`
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

// Processor is a built-in pipeline step. Params carries the key=value options
// parsed from the step's pipeline token (e.g. "timeout=30s" in
// "#readability timeout=30s"); steps that take no options ignore it.
type Processor func(context.Context, Params, *RawItem) error

var registry = map[string]func() Processor{}

// Register registers a built-in processor available as "#name". The init
// factory runs once per New() so a built-in can capture per-instance state.
func Register(name string, init func() Processor) {
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
func New() *Module {
	m := &Module{
		processors: make(map[string]Processor, len(registry)),
		env:        SubprocessEnv(),
	}
	for name, init := range registry {
		m.processors[name] = init()
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

	out, err := RunSubprocess(ctx, args, o.env, "", &buf)
	if err != nil {
		return err
	}

	// Empty/whitespace stdout means the shell step chose to emit nothing (a
	// `true`, a filter that dropped the line, a conditional no-op). Treat it as
	// "leave the item unchanged" rather than feeding "" to json.Unmarshal —
	// which errors with "unexpected end of JSON input" and (per feed.go) would
	// drop the item.
	if len(out) == 0 {
		return nil
	}

	// Preserve the typed Raw payload across the JSON round-trip — Unmarshal
	// would otherwise decode it into map[string]any, breaking type-asserts
	// in built-ins that run after a shell module.
	saved := i.Raw
	if err := json.Unmarshal(out, i); err != nil {
		return err
	}
	i.Raw = saved
	return nil
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
// so a misconfigured pipe fails loudly (a feed-level error) instead of
// silently dropping every item. For each step: an empty step or an unknown
// "#"-prefixed token (incl. a stray "#default" or "#default key=val") is rejected; a
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
