// Autonomous bans: what the watch is allowed to apply on its own, and how it un-applies itself.
//
// Two ideas hold this together. A ban is only automatic if it is also temporary — an auto-applied
// deny expires on a clock, so "a human can revert it" stops meaning "once a human finds out" and
// starts meaning "by 6am whether or not anyone noticed". And a ban is only automatic if its blast
// radius is small: a JA4 identifies a client BUILD, not a person, so a popular one covers a large
// population of real users and is never a safe thing to deny unattended.
//
// Off by default. The flag exists so the loop can be run and studied first: the screen has never
// produced a live `ban` verdict, and enabling this before it has is enabling it on expectation
// rather than on evidence.

/** Env var that turns autonomous applying on. Absent or anything but `1` means advise-only. */
export const AUTO_BAN_FLAG = 'FW_AUTO_BAN';
/** Env var holding `digest|iso` records for bans that expire. */
export const AUTO_BAN_UNTIL = 'FW_AUTO_BAN_UNTIL';
/** Env var holding `digest|count|iso` — how often each identity has been back, and when last. */
export const AUTO_BAN_STRIKES = 'FW_AUTO_BAN_STRIKES';

/** First offence. Doubles per strike from here. */
export const AUTO_BAN_TTL_MS = 6 * 60 * 60_000;

/**
 * Ceiling on the doubling. Past a week the TTL has stopped being a safety net — the whole point
 * of expiry is that a mistake heals itself while nobody is watching, and a ban measured in months
 * does not. An identity still returning after a week has earned a permanent ban that a human
 * decides on, not one the loop reached by repeated doubling.
 */
export const AUTO_BAN_MAX_MS = 7 * 24 * 60 * 60_000;

/**
 * How long a strike counts for. Without decay the list grows for the life of the project and a
 * fingerprint banned once a year ago escalates a completely different actor who happens to share
 * that client build.
 */
export const STRIKE_DECAY_MS = 30 * 24 * 60 * 60_000;

/**
 * How long the next ban on this identity should last: the base, doubled once per prior strike,
 * capped. Coming back is itself evidence — a one-off got the wrong answer, a returner did not.
 */
export function banDuration(
  strikes: number,
  base = AUTO_BAN_TTL_MS,
  cap = AUTO_BAN_MAX_MS,
): number {
  const n = Math.max(0, Math.floor(strikes));
  // Cap the exponent before computing it: 2 ** 1024 is Infinity, and Infinity * base stays
  // Infinity through the Math.min, which is a ban with no expiry at all.
  const doublings = Math.min(n, 40);
  return Math.min(base * 2 ** doublings, cap);
}

/**
 * Ceilings above which a ban is never automatic, whatever the verdict.
 *
 * Deliberately stricter than what the advisory needs to *recommend* a ban: advising costs a human
 * two minutes of reading, applying costs every real user behind that fingerprint.
 */
export type BlastRadius = {
  /** Any rendering at all means a browser has run the app from it. */
  maxRenderingRequests: number;
  /** A fingerprint spread over many addresses is more likely a popular client than one actor. */
  maxIps: number;
  /** Share of all traffic in the window. A big share is a big population. */
  maxShareOfTraffic: number;
};

export const DEFAULT_BLAST_RADIUS: BlastRadius = {
  maxRenderingRequests: 0,
  maxIps: 25,
  maxShareOfTraffic: 0.02,
};

/** True when the operator has explicitly opted in. Anything other than `1` is off. */
export function autoBanEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env[AUTO_BAN_FLAG] === '1';
}

export type BanCandidate = {
  digest: string;
  verdict: string;
  blockers: string[];
  renderingRequests: number;
  ips: number;
  total: number;
  windowTotal: number;
};

/**
 * Whether this candidate may be denied without a human. Returns the reason it may NOT be, so a
 * refusal can be logged as a fact rather than as silence — a gate that declines invisibly is
 * indistinguishable from one that never ran.
 */
export function autoBanRefusal(
  c: BanCandidate,
  limits: BlastRadius = DEFAULT_BLAST_RADIUS,
): string | null {
  if (c.verdict !== 'ban') return `verdict is ${c.verdict}, not ban`;
  if (c.blockers.length) return `advisory blocked it: ${c.blockers[0]}`;
  if (c.renderingRequests > limits.maxRenderingRequests)
    return `${c.renderingRequests} rendering request(s) — a browser has run the app from it`;
  if (c.ips > limits.maxIps)
    return `spans ${c.ips} IPs — too broad to deny unattended`;
  const share = c.windowTotal > 0 ? c.total / c.windowTotal : 0;
  if (share > limits.maxShareOfTraffic)
    return `${(share * 100).toFixed(1)}% of window traffic — too large a population`;
  return null;
}

// `|` separates fields, `,` separates records. Neither can occur in a JA4 digest (hex, letters
// and underscores) nor in an ISO timestamp, so no record can be split wrongly by its own content.
const FIELD = '|';

export type Expiry = { digest: string; until: number };

/** One record, as stored. Readable and greppable, because a human will read this file. */
export function expiryRecord(digest: string, until: Date): string {
  return `${digest.toLowerCase()}${FIELD}${until.toISOString()}`;
}

/**
 * Parse the stored records. Anything unparseable is DROPPED rather than guessed at — a record we
 * cannot read is a ban we cannot expire, and silently inventing an expiry for it would be worse
 * than forgetting it, which at least leaves the digest in the denylist for a human to find.
 */
export function parseExpiries(raw: string | undefined): Expiry[] {
  if (!raw) return [];
  return records(raw).flatMap(([digest, iso]) => {
    if (!digest || !iso) return [];
    const until = Date.parse(iso);
    return Number.isFinite(until) ? [{ digest, until }] : [];
  });
}

/** Serialise back, so the caller only ever writes what this module can read. */
export function serialiseExpiries(e: Expiry[]): string {
  return e.map((x) => expiryRecord(x.digest, new Date(x.until))).join(',');
}

/** Split a stored value into its records and fields, digest lower-cased. */
function records(raw: string): string[][] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(FIELD).map((p) => p.trim());
      return [(parts[0] ?? '').toLowerCase(), ...parts.slice(1)];
    });
}

/**
 * How often an identity has been banned, and when it last was.
 *
 * Kept as state in the env file rather than derived from the watch log. The log is an append-only
 * record for a human — it rotates, it can be deleted, and reading a ban duration back out of it
 * would make a text file load-bearing for whether something is denied for two days.
 */
export type Strike = { digest: string; count: number; at: number };

export function parseStrikes(raw: string | undefined): Strike[] {
  if (!raw) return [];
  return records(raw).flatMap(([digest, n, iso]) => {
    if (!digest || !n || !iso) return [];
    const count = Number(n);
    const at = Date.parse(iso);
    // A strike we cannot read is dropped, like an expiry: guessing a count escalates a ban.
    return Number.isInteger(count) && count > 0 && Number.isFinite(at)
      ? [{ digest, count, at }]
      : [];
  });
}

export function serialiseStrikes(s: Strike[]): string {
  return s
    .map(
      (x) =>
        `${x.digest.toLowerCase()}${FIELD}${x.count}${FIELD}${new Date(x.at).toISOString()}`,
    )
    .join(',');
}

/** Strikes still within the decay window. Older ones are not this actor's record any more. */
export function freshStrikes(
  strikes: Strike[],
  now: number,
  decayMs = STRIKE_DECAY_MS,
): Strike[] {
  return strikes.filter((s) => now - s.at < decayMs);
}

/** How many times this identity has been banned recently — the exponent for `banDuration`. */
export function strikesFor(
  strikes: Strike[],
  digest: string,
  now: number,
  decayMs = STRIKE_DECAY_MS,
): number {
  const d = digest.toLowerCase();
  return (
    freshStrikes(strikes, now, decayMs).find((s) => s.digest === d)?.count ?? 0
  );
}

/** Record another offence, pruning anything that has decayed so the list cannot grow forever. */
export function addStrike(
  strikes: Strike[],
  digest: string,
  now: number,
  decayMs = STRIKE_DECAY_MS,
): Strike[] {
  const d = digest.toLowerCase();
  const fresh = freshStrikes(strikes, now, decayMs);
  const prior = fresh.find((s) => s.digest === d);
  return [
    ...fresh.filter((s) => s.digest !== d),
    { digest: d, count: (prior?.count ?? 0) + 1, at: now },
  ];
}

/** Records whose time is up, and the ones still running. */
export function dueForRevocation(
  records: Expiry[],
  now: number,
): { expired: Expiry[]; live: Expiry[] } {
  return {
    expired: records.filter((r) => r.until <= now),
    live: records.filter((r) => r.until > now),
  };
}
