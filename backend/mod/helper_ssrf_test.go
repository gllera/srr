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
	} {
		if !blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = false, want true", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"} {
		if blockedIP(net.ParseIP(s)) {
			t.Errorf("blockedIP(%s) = true, want false", s)
		}
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
