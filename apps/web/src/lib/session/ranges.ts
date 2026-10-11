import { get } from '@vercel/global-config';

import { ipv4Number, ipv6Groups, isIPv4 } from './address';

/**
 * The Global Config item listing the address ranges search engines and assistants crawl from, as
 * their operators publish them: an array of CIDR strings. Their requests are always served the
 * full document.
 */
export const CRAWLER_RANGES_ITEM = 'crawlerRanges';

/** Parsed ranges, inclusive bounds. */
export type Ranges = {
  v4: ReadonlyArray<readonly [number, number]>;
  v6: ReadonlyArray<readonly [bigint, bigint]>;
};

const ALL_128 = (1n << 128n) - 1n;

/** One CIDR (or a bare address) as inclusive bounds, or null when it is not one. */
function parseRange(
  value: string,
):
  | { family: 4; bounds: readonly [number, number] }
  | { family: 6; bounds: readonly [bigint, bigint] }
  | null {
  const slash = value.indexOf('/');
  const address = (slash === -1 ? value : value.slice(0, slash)).trim();
  const bitsText = slash === -1 ? null : value.slice(slash + 1).trim();
  if (bitsText !== null && !/^\d{1,3}$/.test(bitsText)) return null;
  if (isIPv4(address)) {
    const bits = bitsText === null ? 32 : Number(bitsText);
    if (bits > 32) return null;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    const start = (ipv4Number(address) & mask) >>> 0;
    return { family: 4, bounds: [start, (start | (~mask >>> 0)) >>> 0] };
  }
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const bits = bitsText === null ? 128 : Number(bitsText);
  if (bits > 128) return null;
  const host = (1n << BigInt(128 - bits)) - 1n;
  const start = BigInt(`0x${groups.join('')}`) & (ALL_128 ^ host);
  return { family: 6, bounds: [start, start | host] };
}

/**
 * The ranges a stored value lists, or null unless it is a non-empty array of valid ranges. All or
 * nothing: a list this cannot read whole is treated as no list at all.
 */
export function parseRanges(value: unknown): Ranges | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const v4: Array<readonly [number, number]> = [];
  const v6: Array<readonly [bigint, bigint]> = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const range = parseRange(entry);
    if (!range) return null;
    if (range.family === 4) v4.push(range.bounds);
    else v6.push(range.bounds);
  }
  return { v4, v6 };
}

/** Whether an address falls inside any of the ranges. */
export function inRanges(ranges: Ranges, address: string): boolean {
  if (isIPv4(address)) {
    const n = ipv4Number(address);
    return ranges.v4.some(([start, end]) => n >= start && n <= end);
  }
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const n = BigInt(`0x${groups.join('')}`);
  return ranges.v6.some(([start, end]) => n >= start && n <= end);
}

/** Reads the stored list; undefined when nothing is stored. */
export type ReadRanges = () => Promise<unknown>;

/**
 * The stored list, from Global Config when a store is connected. A local run has none, so it can
 * name its own in `CRAWLER_RANGES_LOCAL` (comma-separated CIDRs).
 */
const readStored: ReadRanges = async () => {
  if (process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG)
    return get(CRAWLER_RANGES_ITEM);
  const local = process.env.CRAWLER_RANGES_LOCAL;
  return local ? local.split(',').map((s) => s.trim()) : undefined;
};

/** How long a read list is reused before it is read again. */
const REREAD_MS = 60_000;

/**
 * Reads the list at most once a minute, keeping the last good list when a read fails. Null (no
 * usable list) means everyone is served the full document. Never throws.
 */
export function createRangesReader(
  read: ReadRanges = readStored,
  rereadMs = REREAD_MS,
) {
  let last: { at: number; ranges: Ranges | null } | null = null;
  return async (now = Date.now()): Promise<Ranges | null> => {
    if (last && now - last.at < rereadMs) return last.ranges;
    let ranges: Ranges | null;
    try {
      ranges = parseRanges(await read());
    } catch (error) {
      console.error(
        '[document] crawler ranges could not be read:',
        error instanceof Error ? error.message : error,
      );
      ranges = last?.ranges ?? null;
    }
    last = { at: now, ranges };
    return ranges;
  };
}

/** The list as the edge reads it. */
export const crawlerRanges = createRangesReader();
