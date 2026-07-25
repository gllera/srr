package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"srr/store"
)

// writeMarker plants a marker with an arbitrary payload, standing in for
// whatever a previous writer (or an older srr) left behind.
func writeMarker(t *testing.T, b store.Backend, key string, payload []byte) {
	t.Helper()
	if err := b.AtomicPut(ctx, key, bytes.NewReader(payload), store.ObjectMeta{}); err != nil {
		t.Fatalf("plant marker: %v", err)
	}
}

func leaseAt(t *testing.T, b store.Backend, key string) storeLease {
	t.Helper()
	l, present, err := readLease(ctx, b, key)
	if err != nil || !present {
		t.Fatalf("read marker %s: present=%v err=%v", key, present, err)
	}
	return l
}

func marshalLease(t *testing.T, l storeLease) []byte {
	t.Helper()
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A lease held by another process that has not expired is a live writer: refuse,
// with the os.ErrExist contract serve turns into a 409.
func TestLeaseRefusesLiveHolder(t *testing.T) {
	db, _, _ := setupTestDB(t)
	held := storeLease{Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(time.Hour).Unix()}
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, held))

	err := acquireMarker(ctx, db.Backend, dbLockKey)
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("acquire against a live lease = %v, want os.ErrExist", err)
	}
	if got := leaseAt(t, db.Backend, dbLockKey); got != held {
		t.Errorf("the live lease was overwritten: %+v", got)
	}
}

// Past its deadline the holder has started no cycle for a whole lease window:
// steal it, and stamp our own lease in its place.
func TestLeaseStealsExpired(t *testing.T) {
	db, _, _ := setupTestDB(t)
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, storeLease{
		Owner:   "otherhost/999/deadbeef",
		Expires: time.Now().Add(-time.Second).Unix(),
	}))

	if err := acquireMarker(ctx, db.Backend, dbLockKey); err != nil {
		t.Fatalf("acquire against an expired lease: %v", err)
	}
	got := leaseAt(t, db.Backend, dbLockKey)
	if got.Owner != leaseOwner {
		t.Errorf("owner after the steal = %q, want %q", got.Owner, leaseOwner)
	}
	if got.expired(time.Now()) {
		t.Error("the stolen lease was stamped already-expired")
	}
}

// A marker bearing THIS process instance's id cannot be held by anything alive:
// storeWriter serializes writers in-process, so it is residue of a cancelled or
// crashed scope. Reclaim it — this is what unwedges a SIGKILLed fetch loop that
// systemd restarts in the same container.
func TestLeaseReclaimsOwnMarker(t *testing.T) {
	db, _, _ := setupTestDB(t)
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, storeLease{
		Owner:   leaseOwner,
		Expires: time.Now().Add(time.Hour).Unix(), // still live, and still ours
	}))

	if err := acquireMarker(ctx, db.Backend, dbLockKey); err != nil {
		t.Fatalf("acquire against our own abandoned lease: %v", err)
	}
	if got := leaseAt(t, db.Backend, dbLockKey).Owner; got != leaseOwner {
		t.Errorf("owner after the reclaim = %q, want %q", got, leaseOwner)
	}
}

// A payload-less marker — an older srr, or a corrupt write — records no owner
// and no deadline, so its liveness is unknowable. Refusing keeps the pre-lease
// behavior for exactly the case where guessing would be unsafe; --force is the
// documented escape.
func TestLeaseRefusesPayloadlessMarker(t *testing.T) {
	db, _, _ := setupTestDB(t)
	for _, payload := range [][]byte{nil, []byte("not json"), []byte(`{}`)} {
		writeMarker(t, db.Backend, dbLockKey, payload)
		if err := acquireMarker(ctx, db.Backend, dbLockKey); !errors.Is(err, os.ErrExist) {
			t.Errorf("acquire against payload %q = %v, want os.ErrExist", payload, err)
		}
	}
}

// --force takes the marker whatever it says, and still stamps a real lease — so
// the forced run is itself stealable if IT is killed.
func TestLeaseForceSteals(t *testing.T) {
	db, _, _ := setupTestDB(t)
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, storeLease{
		Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(time.Hour).Unix(),
	}))
	globals.Force = true

	if err := acquireMarker(ctx, db.Backend, dbLockKey); err != nil {
		t.Fatalf("forced acquire: %v", err)
	}
	got := leaseAt(t, db.Backend, dbLockKey)
	if got.Owner != leaseOwner || got.expired(time.Now()) {
		t.Errorf("forced acquire left %+v; want a live lease owned by this process", got)
	}
}

// Renewal is by re-acquisition: every cycle opens the store afresh, so the
// deadline moves forward one full TTL each time. That is what makes leaseTTL a
// bound on "time since the last cycle STARTED" rather than on uptime.
func TestLeaseRenewsOnEachAcquire(t *testing.T) {
	db, _, _ := setupTestDB(t)
	base := time.Now()
	leaseNow = func() time.Time { return base }
	t.Cleanup(func() { leaseNow = time.Now })

	if err := acquireMarker(ctx, db.Backend, dbLockKey); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	first := leaseAt(t, db.Backend, dbLockKey)
	if want := base.Add(leaseTTL).Unix(); first.Expires != want {
		t.Fatalf("first deadline = %d, want %d", first.Expires, want)
	}

	releaseMarker(ctx, db.Backend, dbLockKey)
	leaseNow = func() time.Time { return base.Add(time.Hour) }
	if err := acquireMarker(ctx, db.Backend, dbLockKey); err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if got, want := leaseAt(t, db.Backend, dbLockKey).Expires, base.Add(time.Hour+leaseTTL).Unix(); got != want {
		t.Errorf("renewed deadline = %d, want %d", got, want)
	}
}

// End to end: a store left locked by a killed process of this same instance
// opens for writing again, and a store held by a live peer still does not.
func TestNewDBLeaseRecovery(t *testing.T) {
	db, _, _ := setupTestDB(t)
	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, storeLease{
		Owner: leaseOwner, Expires: time.Now().Add(time.Hour).Unix(),
	}))
	recovered, err := NewDB(ctx, true)
	if err != nil {
		t.Fatalf("NewDB over our own abandoned lease: %v", err)
	}
	recovered.Close(ctx)

	writeMarker(t, db.Backend, dbLockKey, marshalLease(t, storeLease{
		Owner: "otherhost/999/deadbeef", Expires: time.Now().Add(time.Hour).Unix(),
	}))
	if _, err := NewDB(ctx, true); !errors.Is(err, os.ErrExist) {
		t.Fatalf("NewDB against a live peer's lease = %v, want os.ErrExist", err)
	}
}
