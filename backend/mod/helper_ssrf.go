package mod

import (
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

// AllowPrivateFetch disables the SSRF guard when true. Self-hosters who
// legitimately fetch feeds/media from LAN or loopback addresses opt out via the
// --allow-private-fetch flag / SRR_ALLOW_PRIVATE_FETCH env; main sets this from
// the resolved global after parsing. Defaults false (guard on).
var AllowPrivateFetch bool

// extraBlockedCIDRs are ranges the stdlib IP predicates don't cover but an SSRF
// probe can still reach into infrastructure:
//   - 0.0.0.0/8 — "this network"; on Linux connect() to 0.x.y.z reaches
//     127.0.0.x, the classic loopback bypass (only 0.0.0.0 itself is
//     IsUnspecified).
//   - 100.64.0.0/10 — CGNAT / carrier-grade NAT; some providers put internal
//     services here (Alibaba Cloud's metadata endpoint is 100.100.100.200).
//   - 192.0.0.0/24 — IETF protocol assignments (DS-Lite gateways et al).
//   - 198.18.0.0/15 — IETF benchmarking assignment (RFC 2544).
//   - 240.0.0.0/4 — reserved/experimental space, no legitimate feed host.
//   - 64:ff9b::/96 — the NAT64 well-known prefix. Blocked WHOLESALE (not just
//     via embeddedIPv4): a NAT64 gateway is itself infrastructure, so even a
//     public embedded v4 has no business being dialed through one.
var extraBlockedCIDRs = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24",
		"198.18.0.0/15", "240.0.0.0/4", "64:ff9b::/96",
	}
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

// embeddedIPv4 returns the IPv4 address embedded in the v6 transition formats
// that carry one, else nil. Dialing one of these really reaches that v4
// endpoint, so blockedIP recurses on the extraction — otherwise a loopback or
// RFC-1918 v4 walks past every check wearing a v6 costume (2002:7f00:0001:: is
// 127.0.0.1). Never recurses twice: the result is a v4, which yields nil here.
func embeddedIPv4(ip net.IP) net.IP {
	ip = ip.To16()
	if ip == nil || ip.To4() != nil {
		return nil // not v6 (To4 also covers the ::ffff: v4-mapped form)
	}
	switch {
	case ip[0] == 0x20 && ip[1] == 0x02: // 6to4, 2002::/16 — v4 in bytes 2-5
		return net.IPv4(ip[2], ip[3], ip[4], ip[5])
	case ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x00 && ip[3] == 0x00: // Teredo, 2001::/32
		// The client v4 is the last 4 bytes, obfuscated by XOR with 0xff.
		return net.IPv4(ip[12]^0xff, ip[13]^0xff, ip[14]^0xff, ip[15]^0xff)
	case ip[0] == 0x00 && ip[1] == 0x64 && ip[2] == 0xff && ip[3] == 0x9b: // NAT64, 64:ff9b::/96
		return net.IPv4(ip[12], ip[13], ip[14], ip[15])
	}
	return nil
}

// blockedIP reports whether ip is one an SSRF probe would target: internal
// services, cloud metadata (169.254.169.254, 100.100.100.200), NAT64 gateways,
// localhost-bound admin ports — including a v4 smuggled inside a v6 transition
// address.
//
// The gate is deny-unless-global-unicast: one predicate covers unspecified,
// loopback, link-local (unicast and multicast), every multicast address,
// 255.255.255.255, AND a malformed/wrong-length IP, so the guard fails closed
// and cannot be outlived by a range nobody enumerated. IsGlobalUnicast is true
// for the private/CGNAT ranges, so the specific checks still have to run after
// it.
func blockedIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() {
		return true
	}
	if ip.IsPrivate() { // RFC 1918 + unique-local fc00::/7
		return true
	}
	for _, n := range extraBlockedCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	if v4 := embeddedIPv4(ip); v4 != nil {
		return blockedIP(v4)
	}
	return false
}

// guardDialControl is a net.Dialer.Control hook: it runs after DNS resolution
// with the concrete address about to be dialed, so it blocks SSRF without a
// rebinding TOCTOU and re-checks every hop of a redirect (each hop dials
// afresh). Disabled when SRR_ALLOW_PRIVATE_FETCH is set.
func guardDialControl(_, address string, _ syscall.RawConn) error {
	if AllowPrivateFetch {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("ssrf guard: refusing to dial non-IP address %q", address)
	}
	if blockedIP(ip) {
		return fmt.Errorf("ssrf guard: refusing to dial private/loopback address %s (set SRR_ALLOW_PRIVATE_FETCH=1 to override)", ip)
	}
	return nil
}

// SafeTransport returns an *http.Transport whose dials are screened by the
// SSRF guard. Built-ins that fetch attacker-controlled URLs from feed content
// (#readability) use it so a malicious feed can't pivot the
// server onto the internal network. Callers may set pooling fields on the
// returned transport.
func SafeTransport() *http.Transport {
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second, Control: guardDialControl}
	return &http.Transport{
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}
