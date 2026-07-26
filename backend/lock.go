package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"srr/store"
)

// The advisory markers — `.locked` (the store writer) and `.config.locked` (the
// config sidecar) — are LEASES, not bare existence flags.
//
// A nil-payload marker cannot answer the only question that matters when one is
// found: is the writer that created it still alive? Before leases the answer was
// "assume yes, forever", so a SIGKILL — an OOM kill, a host reboot, a `docker
// stop` past its grace — left the marker behind and wedged the 5-minute fetch
// loop until a human passed --force. A lease answers it two ways:
//
//   - OWNER. A marker bearing THIS process instance's id can only be one this
//     process wrote, and storeWriter (db.go) already serializes writers inside
//     the process — so nothing here is holding it now, and it is provably the
//     residue of a cancelled or crashed scope. Reclaim it.
//   - EXPIRY. Every acquire stamps a deadline leaseTTL out and every cycle
//     acquires afresh, so a marker whose deadline has passed belongs to a writer
//     that has not started a cycle within the whole lease window. Steal it,
//     loudly.
//
// Anything else — a lease that is still live, or a legacy nil-payload marker
// whose liveness is genuinely unknowable — still answers os.ErrExist, which
// serve maps to a 409, the MCP layer to "store busy", and the operator clears
// with --force. That contract is unchanged; only the set of situations that
// reach it shrank.
//
// What a wrong steal costs, stated exactly, because the TTL is chosen against
// it. A stolen store cannot be double-COMMITTED: publishManifest is an exclusive
// create (manifest.go §6.2) and the root flip is a compare-and-swap on the root
// the handle read (db.flipRoot), so the losing writer aborts before publishing
// and neither generation is ever written over the other. That is the guarantee.
//
// It is NOT a guarantee about the OBJECTS. Two live writers reading the same
// manifest draw the same per-series stems from names.next, and every pack write
// is an AtomicPut — overwrite, deliberately, because a crashed cycle leaves an
// orphan at the stem the next cycle re-draws, which makes exclusive-create
// impossible there (db_pack.go savePack). So the loser can overwrite the
// winner's data/<stem>.gz or idx/<stem>.gz on its way to aborting, and the
// winner's published manifest would then name objects holding the loser's bytes:
// idx offsets addressing another cycle's data lines.
//
// Which is why leaseTTL exceeding the longest possible cycle is a CORRECTNESS
// requirement and not headroom for comfort. Stealing a lease from a writer that
// is merely slow — not dead — is the one case this design cannot make safe;
// --force carries the same caveat and always has.

// leaseTTL bounds how long a marker outlives the process that wrote it. It MUST
// exceed the longest single cycle — see the object-clobber paragraph above for
// why that is correctness and not comfort — because a cycle holds its lease for
// its whole duration and renews only by acquiring again next cycle. A steady-
// state consolidation dragging a media backlog runs tens of seconds, so 15
// minutes still unwedges a killed 5-minute loop within a handful of polls.
//
// The case to watch is a FIRST BACKFILL: hundreds of articles self-hosting media
// through an external transcode can run long, and that is exactly when an
// impatient operator runs a second srr against the same store from another box.
// If a legitimate cycle can ever approach this bound, raise the bound — do not
// lower it to unwedge faster.
const leaseTTL = 15 * time.Minute

// leaseNow is the lease clock, a var so the tests can age a marker without
// sleeping (the finalGzip/localOpenFile seam pattern).
var leaseNow = time.Now

// leaseOwner identifies this process INSTANCE. The pid alone will not do — pids
// recycle, and a recycled one would let an unrelated process reclaim a live
// lease as "its own" — so a random nonce joins the host and pid.
var leaseOwner = newLeaseOwner()

func newLeaseOwner() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		// Only weakens the owner check to (host, pid), which still refuses
		// every live lease — the safe direction.
		return fmt.Sprintf("%s/%d", host, os.Getpid())
	}
	return fmt.Sprintf("%s/%d/%s", host, os.Getpid(), hex.EncodeToString(nonce[:]))
}

// storeLease is the marker payload. Additive by design: an older binary reading
// a lease file still sees only "the key exists", which is exactly what it acted
// on before.
type storeLease struct {
	Owner   string `json:"owner"`
	Expires int64  `json:"expires"`
}

func (l storeLease) expired(now time.Time) bool { return l.Expires <= now.Unix() }

func (l storeLease) until() string {
	return time.Unix(l.Expires, 0).UTC().Format(time.RFC3339)
}

// acquireMarker takes key as a lease. Every refusal wraps os.ErrExist, so the
// 409 / "store busy" classification callers already do is untouched.
func acquireMarker(ctx context.Context, b store.Backend, key string) error {
	now := leaseNow()
	body, err := json.Marshal(storeLease{Owner: leaseOwner, Expires: now.Add(leaseTTL).Unix()})
	if err != nil {
		return err
	}
	// --force is the operator saying "I know nothing else is running": it still
	// stamps a real lease, so the run that follows is itself stealable.
	if globals.Force {
		return b.AtomicPut(ctx, key, bytes.NewReader(body), store.ObjectMeta{})
	}

	err = b.Put(ctx, key, bytes.NewReader(body), false)
	if !errors.Is(err, os.ErrExist) {
		return err
	}

	held, present, rerr := readLease(ctx, b, key)
	switch {
	case rerr != nil:
		// The two error operands carry different verbs on purpose, and errorlint
		// cannot tell that apart from an oversight. os.ErrExist is this error's
		// dispatch IDENTITY — exitCodeFor maps it to exit 3, serve and the MCP
		// layer to 409 / "store busy" — and it is the only identity a caller may
		// match on: the store is locked, full stop. rerr is why we could not name
		// the holder, which is diagnostic, and %v already puts every byte of it in
		// the message. Promoting it to a second %w would add a cause nothing
		// dispatches on to the most classification-sensitive error in the tree —
		// no information gained, one more way for a future classifier that tests
		// cancellation before contention to answer the wrong question.
		//nolint:errorlint // %v is deliberate; see above
		return fmt.Errorf("%s exists and could not be read to classify its holder (%v); if no srr is running, clear it with --force: %w", key, rerr, os.ErrExist)
	case !present:
		// Released between our create and this read — one clean retry, and any
		// second collision is a genuinely live peer.
		return b.Put(ctx, key, bytes.NewReader(body), false)
	case held.Owner == "":
		return fmt.Errorf("%s was left by a writer that recorded no lease (an older srr, or a corrupt marker), so its liveness cannot be judged; if no srr is running, clear it with --force: %w", key, os.ErrExist)
	case held.Owner == leaseOwner:
		slog.Info("reclaiming this process's own abandoned lease", "key", key)
	case held.expired(now):
		slog.Warn("stealing an expired lease: its holder started no cycle within the lease window and is presumed dead",
			"key", key, "owner", held.Owner, "expired", held.until())
	default:
		return fmt.Errorf("%s is held by %s until %s: %w", key, held.Owner, held.until(), os.ErrExist)
	}
	return b.AtomicPut(ctx, key, bytes.NewReader(body), store.ObjectMeta{})
}

// readLease reads a marker. present is false when the key vanished under us.
func readLease(ctx context.Context, b store.Backend, key string) (l storeLease, present bool, err error) {
	rc, err := getOptional(ctx, b, key)
	if err != nil {
		return l, false, err
	}
	if rc == nil {
		return l, false, nil
	}
	defer rc.Close()
	// The marker is a handful of bytes; a payload that is not a lease (the
	// legacy nil body) simply leaves Owner empty, which the caller refuses.
	data, err := io.ReadAll(io.LimitReader(rc, 4096))
	if err != nil {
		return l, true, err
	}
	if err := json.Unmarshal(data, &l); err != nil {
		return storeLease{}, true, nil
	}
	return l, true, nil
}

// releaseMarker drops key. Warn-only and under WithoutCancel, so a cancelled
// scope still releases; a release that genuinely fails is now recoverable
// without a human, which is the whole point of the lease.
func releaseMarker(ctx context.Context, b store.Backend, key string) {
	if err := b.Rm(context.WithoutCancel(ctx), key); err != nil {
		slog.Warn("remove lock file", "key", key, "error", err)
	}
}
