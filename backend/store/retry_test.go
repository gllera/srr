package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"syscall"
	"testing"
	"testing/iotest"
	"time"
)

// withFastRetry shrinks the backoff for one test: exhausting the ladder is then
// microseconds instead of the real ~300ms.
func withFastRetry(t *testing.T) {
	t.Helper()
	saved := retryBaseWait
	retryBaseWait = time.Microsecond
	t.Cleanup(func() { retryBaseWait = saved })
}

// lostConn is a connection-class error shaped the way a backend surfaces one:
// wrapped in the op's own context, never bare.
func lostConn(op string) error {
	return fmt.Errorf("%s: %w", op, syscall.ECONNRESET)
}

// timeoutErr is a net.Error that timed out — the other retryable class.
type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func TestWithRetrySucceedsAfterTransientFailures(t *testing.T) {
	withFastRetry(t)
	calls := 0
	err := withRetry(ctx, func(attempt int) error {
		calls++
		if attempt != calls {
			t.Errorf("attempt = %d on call %d, want them to agree", attempt, calls)
		}
		if calls < retryAttempts {
			return lostConn("read")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withRetry = %v, want nil on the last attempt", err)
	}
	if calls != retryAttempts {
		t.Errorf("calls = %d, want %d", calls, retryAttempts)
	}
}

// The ladder is bounded: an outage must surface as the store's own error rather
// than being retried while the writer holds the lock.
func TestWithRetryStopsAtTheAttemptCap(t *testing.T) {
	withFastRetry(t)
	calls := 0
	want := lostConn("read")
	err := withRetry(ctx, func(int) error {
		calls++
		return want
	})
	if !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("err = %v, want the op's own connection error", err)
	}
	if calls != retryAttempts {
		t.Errorf("calls = %d, want exactly %d", calls, retryAttempts)
	}
}

func TestWithRetryTimeoutIsRetryable(t *testing.T) {
	withFastRetry(t)
	calls := 0
	if err := withRetry(ctx, func(attempt int) error {
		calls++
		if attempt == 1 {
			return fmt.Errorf("stat: %w", timeoutErr{})
		}
		return nil
	}); err != nil {
		t.Fatalf("withRetry = %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2 — a net.Error timeout is connection-class", calls)
	}
}

// The exclusions are the load-bearing half of the policy: each of these is a
// definitive answer a repeat could only corrupt (see retryable).
func TestWithRetryNeverRepeatsADefinitiveAnswer(t *testing.T) {
	withFastRetry(t)
	cases := map[string]error{
		"absent":         errMissing("stat file", "idx/7.gz"),
		"already exists": fmt.Errorf("key %q already exists: %w", ".locked", os.ErrExist),
		"cas lost":       fmt.Errorf("db.gz: %w", ErrPreconditionFailed),
		"unsupported":    errors.ErrUnsupported,
		"cancelled":      fmt.Errorf("http get: %w", context.Canceled),
		"deadline":       fmt.Errorf("http get: %w", context.DeadlineExceeded),
		"server error":   errors.New("http put: 500 Internal Server Error"),
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			calls := 0
			err := withRetry(ctx, func(int) error {
				calls++
				return want
			})
			if !errors.Is(err, want) {
				t.Errorf("err = %v, want %v surfaced verbatim", err, want)
			}
			if calls != 1 {
				t.Errorf("calls = %d, want 1 — %s must never be retried", calls, name)
			}
		})
	}
	// The absence error additionally has to keep satisfying the contract the
	// callers ask with, not merely avoid the retry.
	if !errors.Is(cases["absent"], fs.ErrNotExist) {
		t.Error("the missing-key case is no longer an fs.ErrNotExist")
	}
}

// A cancelled cycle stops here rather than sleeping out its remaining attempts.
func TestWithRetryStopsOnACancelledContext(t *testing.T) {
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	calls := 0
	start := time.Now()
	err := withRetry(cancelled, func(int) error {
		calls++
		return lostConn("read")
	})
	if !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("err = %v, want the op's own error", err)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 on a dead context", calls)
	}
	if elapsed := time.Since(start); elapsed > retryBaseWait {
		t.Errorf("waited %v; a cancelled context must not pay the backoff", elapsed)
	}
}

// A seekable body replays in FULL from where the call began — including a source
// the caller had already positioned, which is how an asset upload hands one over.
func TestWithRetryBodyReplaysASeekableSource(t *testing.T) {
	withFastRetry(t)
	src := strings.NewReader("--payload")
	if _, err := io.CopyN(io.Discard, src, 2); err != nil {
		t.Fatal(err)
	}

	var seen []string
	err := withRetryBody(ctx, src, func(attempt int, body io.Reader) error {
		b, err := io.ReadAll(body)
		if err != nil {
			t.Fatalf("reading body: %v", err)
		}
		seen = append(seen, string(b))
		if attempt == 1 {
			return lostConn("write")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withRetryBody = %v, want nil", err)
	}
	if len(seen) != 2 || seen[0] != "payload" || seen[1] != "payload" {
		t.Errorf("bodies = %q, want the same complete payload twice", seen)
	}
}

// The guard that keeps a truncated object off an immutable, cached-forever key:
// a consumed body that cannot be rewound ends the retry, error and all.
func TestWithRetryBodyRefusesToReplayAConsumedStream(t *testing.T) {
	withFastRetry(t)
	src := iotest.OneByteReader(strings.NewReader("payload")) // no Seeker
	calls := 0
	err := withRetryBody(ctx, src, func(_ int, body io.Reader) error {
		calls++
		if _, err := io.CopyN(io.Discard, body, 3); err != nil {
			t.Fatalf("reading body: %v", err)
		}
		return lostConn("write")
	})
	if !errors.Is(err, syscall.ECONNRESET) {
		t.Errorf("err = %v, want the op's own error", err)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 — a partly-read unrewindable body must not be replayed", calls)
	}
}

// The common connection-class case: the session was already dead, so the attempt
// failed before reading a byte. Nothing was consumed, so nothing needs rewinding
// — even for a source that could not have been rewound.
func TestWithRetryBodyRetriesAnUntouchedStream(t *testing.T) {
	withFastRetry(t)
	src := iotest.OneByteReader(strings.NewReader("payload"))
	calls := 0
	err := withRetryBody(ctx, src, func(attempt int, body io.Reader) error {
		calls++
		if attempt == 1 {
			return lostConn("open")
		}
		b, err := io.ReadAll(body)
		if err != nil {
			t.Fatalf("reading body: %v", err)
		}
		if string(b) != "payload" {
			t.Errorf("body = %q, want the complete payload", b)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withRetryBody = %v, want nil", err)
	}
	if calls != 2 {
		t.Errorf("calls = %d, want 2", calls)
	}
}
