// The visitor's address, and the part of it a session is bound to. Shared by the edge
// middleware and the server, so both read the same address the same way.

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const GROUP_RE = /^[0-9a-f]{1,4}$/;

/** True for a dotted-quad IPv4 address. */
export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/** An IPv4 address as an unsigned 32-bit number. Assumes `isIPv4`. */
export function ipv4Number(value: string): number {
  return (
    value.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0) >>> 0
  );
}

/**
 * An IPv6 address as its eight groups, four hex digits each, or null when it is not one. Accepts
 * the compressed form, a zone suffix, and an embedded IPv4 tail.
 */
export function ipv6Groups(value: string): string[] | null {
  let v = value.trim().toLowerCase();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  const lastColon = v.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = v.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const n = ipv4Number(tail);
    v = `${v.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => GROUP_RE.test(g)))
    return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/**
 * The visitor's address as the platform reports it, or null when there is none (a local run).
 * Vercel sets `x-real-ip` itself and overwrites `x-forwarded-for`, so neither is the client's to
 * choose.
 */
export function clientAddress(headers: Headers): string | null {
  const candidates = [
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value && (isIPv4(value) || ipv6Groups(value))) return value;
  }
  return null;
}

/** The part of an address a session is bound to: IPv4 whole, IPv6 by its /64. Null otherwise. */
export function addressScope(address: string): string | null {
  if (isIPv4(address)) return address;
  const groups = ipv6Groups(address);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : null;
}
