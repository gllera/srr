package store

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"net"
	"os"
	"syscall"
	"time"

	"github.com/pkg/sftp"
)

// Transient-failure retry for the connection-bound backends.
//
// A fetch cycle opens the store ONCE and then runs for minutes: one dropped TCP
// connection in the middle of it used to fail not just the op that hit it but
// every op after it (an SFTP handle held a client whose peer was gone), and the
// all-or-nothing passes — expiration stats every asset before deleting any —
// abort wholesale on a single flaky round trip. One redial and one repeat is the
// whole fix.
//
// It applies to SFTP and HTTP. S3 keeps the SDK's own retryer (configured,
// jittered, and aware of which S3 errors are retryable in a way nothing here
// could be), and the local backend has no connection to lose.

// retryAttempts is the TOTAL number of tries a wrapped op gets, first included.
// Three is chosen against the failure it exists for: a connection that died
// between two ops needs exactly one redial, and anything still failing on the
// third try is an outage, not a blip — a longer ladder only delays the honest
// error while the store lock is held.
const retryAttempts = 3

// retryBaseWait is the first inter-attempt pause; each further one doubles it.
// Worst case adds well under a second to an op that then fails anyway. A var so
// a test exhausting the ladder costs microseconds rather than real time.
var retryBaseWait = 100 * time.Millisecond

// withRetry runs op until it succeeds, answers something other than a
// connection-class failure, or runs out of attempts. op receives its 1-based
// attempt number so a backend can re-resolve per-attempt state — SFTP redials
// its shared session before every attempt past the first.
//
// ONLY idempotent, body-less ops belong here. The entire policy rests on
// "running this twice is indistinguishable from running it once", which Get,
// Stat, Rm and List satisfy by construction and an exclusive-create Put
// famously does not (see retryable).
func withRetry(ctx context.Context, op func(attempt int) error) error {
	return retryLoop(ctx, nil, op)
}

// withRetryBody is withRetry for an op that CONSUMES a body. A failed attempt
// has already read part of r, so re-invoking with the same reader would write a
// TRUNCATED object — under a name that is immutable and cached forever. The
// rewinder is what makes that impossible: it retries only when the source is
// provably back at the offset the call started from.
func withRetryBody(ctx context.Context, r io.Reader, op func(attempt int, body io.Reader) error) error {
	rw := &rewinder{src: r}
	if s, ok := r.(io.Seeker); ok {
		// Record where the caller's reader stands NOW rather than assuming 0: an
		// asset upload hands us an *os.File the hash pass may have positioned.
		if pos, err := s.Seek(0, io.SeekCurrent); err == nil {
			rw.seek, rw.start = s, pos
		}
	}
	return retryLoop(ctx, rw.rewind, func(attempt int) error { return op(attempt, rw) })
}

// retryLoop is the shared driver. reset (nil for a body-less op) is the proof
// obligation a retry must discharge first: it reports whether the op can be
// replayed at all, and a false answer ends the loop with the op's own error.
func retryLoop(ctx context.Context, reset func() bool, op func(attempt int) error) error {
	for attempt := 1; ; attempt++ {
		err := op(attempt)
		if err == nil || attempt == retryAttempts || !retryable(ctx, err) {
			return err
		}
		if reset != nil && !reset() {
			return err
		}
		slog.Debug("store op failed transiently, retrying", "attempt", attempt, "err", err)
		if !waitBackoff(ctx, attempt) {
			return err
		}
	}
}

// retryable classifies a backend error as a lost connection — the ONLY class
// this package repeats an operation on.
//
// The exclusions are the load-bearing half, and each is a definitive answer that
// a repeat could only corrupt:
//
//   - fs.ErrNotExist — the absence contract. "It is not there" is a fact, and a
//     caller acting on it (skip the upload, treat the store as empty) must never
//     have been handed a disguised timeout; that is the whole point of the
//     one-absence-error rule in Backend.
//   - os.ErrExist — the exclusive-create answer. A retried `.locked` acquire
//     would find the marker THIS process just wrote and report contention
//     against itself, wedging the writer until a human passes --force. Backends
//     additionally never route an exclusive create through the retry at all;
//     this is the second lock on that door.
//   - ErrPreconditionFailed — the conditional-write loser. Retrying it would
//     re-read nothing and re-publish over the peer generation that won, which is
//     exactly the silent last-write-wins the CAS exists to prevent.
//   - errors.ErrUnsupported — a permanent capability answer (HTTP's List and
//     Version), not a hiccup.
//   - context cancellation — the caller has gone; sleeping and repeating burns
//     the shutdown grace period to produce the same error.
//
// Everything not connection-class (an HTTP 5xx, a permission denial, a malformed
// response) also falls through to "no": those are the store telling us something,
// and a repeat neither learns more nor costs less than surfacing it.
func retryable(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, os.ErrExist) ||
		errors.Is(err, ErrPreconditionFailed) || errors.Is(err, errors.ErrUnsupported) {
		return false
	}
	// context.DeadlineExceeded satisfies net.Error with Timeout() true, so the
	// cancellation check MUST come before the timeout check below.
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var nerr net.Error
	if errors.As(err, &nerr) && nerr.Timeout() {
		return true
	}
	// A pre-response EOF is the classic keep-alive/session death: the peer closed
	// while we were waiting for its answer, so nothing of the op was observed.
	// pkg/sftp surfaces the same event as io.EOF from its receive loop or, when
	// the server says so itself, as the connection-lost status.
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, sftp.ErrSSHFxConnectionLost)
}

// waitBackoff pauses before the next attempt: an exponential base with half
// jitter, so the many ops a cycle runs in parallel (the asset fan-out, RmAll's
// workers) that all trip over the SAME dropped connection do not resynchronise
// onto the reconnecting server. Reports false when the caller's context ends
// first — a cancelled cycle stops here instead of sleeping out its attempts.
func waitBackoff(ctx context.Context, attempt int) bool {
	base := retryBaseWait << (attempt - 1)
	// G404 is not a finding here: the jitter exists to SPREAD concurrent
	// retries so they do not re-collide, not to be unguessable. A crypto
	// source would buy nothing and can block.
	t := time.NewTimer(base/2 + rand.N(base/2)) //nolint:gosec // G404: jitter needs spread, not unpredictability
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// rewinder is the replay proof for a body-carrying op. It counts whether an
// attempt read anything and, before a retry, either
//
//   - reports that nothing was read — the overwhelmingly common
//     connection-class case, since a dead session fails at the open or the
//     request send, before the first byte of payload;
//   - seeks the source back to where the call began (an *os.File asset, a
//     *bytes.Reader pack), which replays it in full; or
//   - refuses, and the caller's error stands.
//
// There is deliberately no buffering fallback: packs and assets are the bodies
// here, and quietly holding one in memory to enable a retry would trade a rare
// transient failure for a routine memory spike.
type rewinder struct {
	src   io.Reader
	seek  io.Seeker // non-nil only when src's position could be read back
	start int64     // src's offset when the op began
	dirty bool      // an attempt consumed at least one byte
}

func (rw *rewinder) Read(p []byte) (int, error) {
	n, err := rw.src.Read(p)
	if n > 0 {
		rw.dirty = true
	}
	return n, err
}

// rewind reports whether the body is back at its starting position, so the next
// attempt writes the same bytes the first one meant to.
func (rw *rewinder) rewind() bool {
	if !rw.dirty {
		return true
	}
	if rw.seek == nil {
		return false
	}
	if _, err := rw.seek.Seek(rw.start, io.SeekStart); err != nil {
		return false
	}
	rw.dirty = false
	return true
}
