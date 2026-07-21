package mod

import (
	"net"
	"testing"
)

func TestBlockedIP(t *testing.T) {
	for _, s := range []string{
		"127.0.0.1", "::1", // loopback
		"10.0.0.1", "192.168.1.1", "172.16.0.1", // RFC1918
		"169.254.169.254", "fe80::1", // link-local (incl. cloud metadata)
		"0.0.0.0", "::", // unspecified
		"fc00::1",                       // unique-local
		"100.64.0.1", "100.100.100.200", // CGNAT (incl. Alibaba Cloud metadata)
		"64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
		"198.18.0.1",         // IETF benchmarking range
		"0.1.2.3",            // "this network" — Linux connect() reaches 127.0.0.x
		"255.255.255.255",    // broadcast
		"240.0.0.1",          // reserved/experimental
		"192.0.0.10",         // IETF protocol assignments
		"ff02::1",            // link-local multicast
		// v4 smuggled inside a v6 transition address: the dial really lands on
		// the embedded endpoint, so the extraction must be re-checked.
		"2002:7f00:0001::",         // 6to4 of 127.0.0.1
		"2002:a9fe:a9fe::",         // 6to4 of 169.254.169.254
		"2001:0:0:0:0:0:f5ff:fffe", // Teredo of 10.0.0.1 (client v4 XOR 0xff)
		"::ffff:127.0.0.1",         // v4-mapped loopback
	} {
		if !blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = false, want true", s)
		}
	}
	for _, s := range []string{
		"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1",
		"2002:0808:0808::",         // 6to4 of the public 8.8.8.8 — still routable
		"2001:0:0:0:0:0:f7f7:f7f7", // Teredo of the public 8.8.8.8
	} {
		if blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = true, want false", s)
		}
	}
	// A malformed address must fail CLOSED (ParseIP yields nil).
	if !blockedIP(nil) {
		t.Error("blockedIP(nil) = false, want true (fail closed)")
	}
}

func TestGuardDialControlBlocksPrivate(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:80", "169.254.169.254:80", "10.1.2.3:443"} {
		if err := guardDialControl("tcp", addr, nil); err == nil {
			t.Errorf("guardDialControl(%s) = nil, want blocked", addr)
		}
	}
	if err := guardDialControl("tcp", "8.8.8.8:443", nil); err != nil {
		t.Errorf("public IP should be allowed, got %v", err)
	}
}

// allowPrivateForTest flips the SSRF opt-out for the duration of a test and
// restores it after (production sets mod.AllowPrivateFetch from the resolved
// --allow-private-fetch global; tests set it directly).
func allowPrivateForTest(t *testing.T) {
	t.Helper()
	prev := AllowPrivateFetch
	AllowPrivateFetch = true
	t.Cleanup(func() { AllowPrivateFetch = prev })
}

func TestGuardDialControlOptOut(t *testing.T) {
	allowPrivateForTest(t)
	if err := guardDialControl("tcp", "127.0.0.1:80", nil); err != nil {
		t.Errorf("AllowPrivateFetch should allow loopback, got %v", err)
	}
}

// A resolved address that is not an IP is refused: guardDialControl runs after
// DNS with the concrete dial address, so a non-IP there means something is
// wrong — never dial it.
func TestGuardDialControlRefusesNonIP(t *testing.T) {
	if err := guardDialControl("tcp", "not-an-ip", nil); err == nil {
		t.Error("guardDialControl(non-IP) = nil, want refused")
	}
}

// When SplitHostPort fails (no ':port'), the whole address is treated as the
// host and still guarded: a bare private/loopback IP with no port is blocked,
// a bare public IP allowed.
func TestGuardDialControlBareHostFallback(t *testing.T) {
	if err := guardDialControl("tcp", "127.0.0.1", nil); err == nil {
		t.Error("guardDialControl(bare loopback IP, no port) = nil, want blocked")
	}
	if err := guardDialControl("tcp", "8.8.8.8", nil); err != nil {
		t.Errorf("guardDialControl(bare public IP, no port) = %v, want allowed", err)
	}
}
