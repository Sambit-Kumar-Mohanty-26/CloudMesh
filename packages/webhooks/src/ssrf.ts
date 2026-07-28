import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * The design doc's SSRF guard, checked at both registration time (reject
 * 400 immediately) AND delivery time (DNS can change between registration
 * and delivery — "DNS rebinding": an org registers a URL that resolves to a
 * public IP, passes the check, then repoints the DNS record at
 * 169.254.169.254 before the first delivery actually fires). Skipping the
 * delivery-time check because "it already passed at registration" is
 * exactly the hole this guard exists to close.
 *
 * Resolves the hostname rather than trusting the literal string — a bare
 * IPv4/IPv6 literal in the URL is checked directly; a hostname is resolved
 * via DNS and EVERY returned address is checked, not just the first one a
 * client might connect to.
 */
export async function isSafeWebhookTarget(rawUrl: string): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "https:") {
    return { safe: false, reason: "only https URLs are allowed" };
  }

  // WHATWG URL keeps brackets on an IPv6 literal host ("[::1]"), which
  // node:net's isIP() does not recognize — an unstripped check here would
  // silently fall through to DNS lookup (which fails, since "[::1]" isn't a
  // resolvable name) and reject on the wrong grounds instead of catching
  // the literal directly.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  if (literal) {
    return checkAddress(hostname)
      ? { safe: true }
      : { safe: false, reason: unsafeReason(hostname) };
  }

  let addresses: string[];
  try {
    // Both families — a hostname that only fails the check on its AAAA
    // record (or only its A record) must still be rejected.
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    return { safe: false, reason: "hostname does not resolve" };
  }

  if (addresses.length === 0) {
    return { safe: false, reason: "hostname does not resolve" };
  }

  for (const address of addresses) {
    if (!checkAddress(address)) {
      return { safe: false, reason: unsafeReason(address) };
    }
  }

  return { safe: true };
}

function unsafeReason(address: string): string {
  return `resolves to a disallowed address (${address})`;
}

function checkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isSafeIPv4(address);
  if (version === 6) return isSafeIPv6(address);
  return false; // couldn't parse — fail closed
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(address: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseInt & mask);
}

/**
 * The design doc's exact three ranges (10/8, 172.16/12, 192.168/16 private;
 * 127/8 loopback; 169.254/16 link-local, which is what blocks
 * 169.254.169.254 — the AWS/GCP/Azure metadata endpoint the doc calls out
 * by name), plus a few additional ranges that are the same category of
 * hazard and worth closing at the same time: 0.0.0.0/8 ("this network"),
 * 100.64.0.0/10 (carrier-grade NAT, used by some cloud metadata setups),
 * and 224.0.0.0/4 (multicast, never a legitimate webhook target).
 */
function isSafeIPv4(address: string): boolean {
  const int = ipv4ToInt(address);
  const blocked: Array<[string, number]> = [
    ["10.0.0.0", 8],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["0.0.0.0", 8],
    ["100.64.0.0", 10],
    ["224.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => inCidr(int, base, bits));
}

/** Unwraps an IPv4-mapped IPv6 address to its dotted-decimal form, in
 *  EITHER notation WHATWG URL parsing can produce: the literal
 *  `::ffff:a.b.c.d` form, or `::ffff:XXXX:YYYY` — two hex groups encoding
 *  the same 4 bytes, which is what `new URL("https://[::ffff:169.254.169.254]/")`
 *  actually normalizes its hostname to. A check that only recognizes the
 *  dotted-decimal spelling misses exactly the input the URL parser hands
 *  back, which is precisely the bypass this exists to close — caught by
 *  this package's own SSRF test suite, not a live incident. */
function unwrapIPv4Mapped(normalized: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (dotted) return dotted[1];

  const hexGroups = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (hexGroups) {
    const high = parseInt(hexGroups[1]!, 16);
    const low = parseInt(hexGroups[2]!, 16);
    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
  }

  return undefined;
}

/**
 * IPv6 loopback (::1), link-local (fe80::/10), and unique-local (fc00::/7,
 * the IPv6 analogue of RFC1918 private space) are rejected outright.
 * IPv4-mapped IPv6 addresses are unwrapped and re-checked against the IPv4
 * rules — `::ffff:169.254.169.254` resolves the metadata endpoint just as
 * effectively as the bare IPv4 form does, and a check that only inspects
 * the IPv6 shape would miss it entirely.
 */
function isSafeIPv6(address: string): boolean {
  const normalized = address.toLowerCase();

  const mapped = unwrapIPv4Mapped(normalized);
  if (mapped) {
    return isSafeIPv4(mapped);
  }

  if (normalized === "::1" || normalized === "::") return false;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return false; // fe80::/10 (approx by prefix)
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false; // fc00::/7

  return true;
}
