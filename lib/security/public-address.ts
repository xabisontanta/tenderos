import { isIP } from "node:net";

/**
 * Whether an address must never be connected to on behalf of someone else's URL or host name: private, loopback,
 * link-local (including the cloud metadata address), shared, documentation, multicast and reserved ranges, for IPv4 and
 * IPv6, including IPv4 addresses written inside IPv6. Anything that is not a plain address (a name, a hex or decimal
 * IPv4 spelling, an empty string) counts as refused: callers pass the result of resolving a name, never the name.
 *
 * Used by the SMTP host check (lib/email/network.ts) and the tender document fetcher (lib/tender-documents).
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip.split(".").map(Number));
  if (kind === 6) return privateV6(ip);
  return true;
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when it cannot be read. */
function groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // An IPv4 tail (::ffff:1.2.3.4) is two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(fill).fill("0"), ...rest];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n)) ? nums : null;
}

const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function privateV6(ip: string): boolean {
  const g = groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  // ::/96 (unspecified, loopback and the deprecated IPv4-compatible form): no public host lives here.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96 IPv4-mapped.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return privateV4(embeddedV4(g6, g7));
  // 64:ff9b::/96 NAT64 carries an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || privateV4(embeddedV4(g6, g7));
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x2002) return privateV4(embeddedV4(g1, g2)); // 6to4 embeds the IPv4 address
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}
