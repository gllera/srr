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
//   - 100.64.0.0/10 — CGNAT / carrier-grade NAT; some providers put internal
//     services here (Alibaba Cloud's metadata endpoint is 100.100.100.200).
//   - 64:ff9b::/96 — the NAT64 well-known prefix; it embeds an IPv4 address, so
//     64:ff9b::a9fe:a9fe reaches 169.254.169.254 where a NAT64 gateway exists.
//   - 198.18.0.0/15 — IETF benchmarking assignment (RFC 2544).
var extraBlockedCIDRs = func() []*net.IPNet {
	nets := make([]*net.IPNet, 0, 3)
	for _, c := range []string{"100.64.0.0/10", "64:ff9b::/96", "198.18.0.0/15"} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

// blockedIP reports whether ip is a private, loopback, link-local, unique-local
// (covered by IsPrivate for fc00::/7), unspecified, or multicast address — plus
// the extraBlockedCIDRs — i.e. the ranges an SSRF probe would target (internal
// services, cloud metadata at 169.254.169.254 or 100.100.100.200, NAT64,
// localhost-bound admin ports).
func blockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	for _, n := range extraBlockedCIDRs {
		if n.Contains(ip) {
			return true
		}
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
