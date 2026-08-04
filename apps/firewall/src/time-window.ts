// Resolving a typed date range into a concrete query window.
//
// The observability API rejects a startTime older than 7 days on the free tier, and demands that
// start/end be multiples of the granularity. Both are enforced here rather than discovered as a
// 400 mid-query, so the operator is told what is possible while they are typing.

export const MAX_WINDOW_DAYS = 7;

export type Window = {
  fromISO: string;
  toISO: string;
  hours: number; // may be fractional for a sub-hour window
  minutes: number; // the canonical duration
  /** Start/end must be multiples of the query granularity, so a sub-hour window needs 10-minute buckets. */
  granularityMinutes: number;
  label: string; // what the UI shows, e.g. "live" or "01 Aug - 04 Aug"
};

/** Presets cycled with a single key. `live` is the "is it happening right now" view. */
export const WINDOW_PRESETS: { label: string; minutes: number }[] = [
  { label: 'live', minutes: 20 },
  { label: 'last 1h', minutes: 60 },
  { label: 'last 3h', minutes: 180 },
  { label: 'last 6h', minutes: 360 },
  { label: 'last 24h', minutes: 1440 },
  { label: 'last 6d', minutes: 6 * 1440 },
];

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** UTC midnight from three already-extracted numeric parts, or null when they are not a real date. */
function dateFrom(parts: string[]): Date | null {
  const [mm, dd, yyyy] = parts;
  if (yyyy.length !== 4) return null;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(Number(yyyy), month - 1, day));
  // Round-trip check rejects 02 31 2026, which Date would roll into March.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/** `mm dd yyyy`, with any of space / . or - between the parts. Returns UTC midnight, or null. */
export function parseDate(text: string): Date | null {
  const nums = text.trim().match(/\d+/g);
  return nums?.length === 3 ? dateFrom(nums) : null;
}

function stamp(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
}

/** Round up to the next `step`-minute boundary; the API rejects a start or end that is not a multiple of the granularity. */
function ceilTo(d: Date, step: number): Date {
  const ms = step * 60_000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}
const ceilHour = (d: Date) => ceilTo(d, 60);

/** Under two hours the query needs 10-minute buckets, or an hour-aligned window would swallow the whole point of asking for a short one. */
function granularityFor(minutes: number): number {
  return minutes <= 120 ? 10 : 60;
}

/**
 * Parse `mm dd yyyy` (that day until now) or `mm dd yyyy - mm dd yyyy` (inclusive of the end
 * day). Returns a message instead of a window when the range is unusable, which the prompt shows
 * verbatim — an invalid range should never reach the API.
 */
export function resolveWindow(
  text: string,
  now: Date,
): { window: Window } | { error: string } {
  const raw = text.trim();
  if (!raw) return { error: 'enter a date as mm dd yyyy' };
  // Count the numbers rather than split on a separator: three is one date, six is a range,
  // and it then does not matter whether they were joined by a dash, a slash or just spaces.
  const nums = raw.match(/\d+/g) ?? [];
  const FORMAT = 'try 08 02 2026, or 08 02 2026 - 08 04 2026';

  let from: Date | null;
  let to: Date | null = null;
  if (nums.length === 6) {
    from = dateFrom(nums.slice(0, 3));
    to = dateFrom(nums.slice(3));
    if (!from || !to) return { error: `that is not a real date — ${FORMAT}` };
    // The end day is inclusive: a single-day range must cover that whole day.
    to = new Date(to.getTime() + 24 * 3600_000);
  } else if (nums.length === 3) {
    from = dateFrom(nums);
    if (!from) return { error: `that is not a real date — ${FORMAT}` };
  } else {
    return { error: FORMAT };
  }

  const end = ceilHour(to && to.getTime() < now.getTime() ? to : now);
  const start = ceilHour(from);
  // Future first: with `end` clamped to now, a future start also trips the ordering check, and
  // "must be before the end date" is a confusing way to say "that day has not happened yet".
  if (start.getTime() > now.getTime())
    return { error: 'that start date is in the future' };
  if (start.getTime() >= end.getTime())
    return { error: 'the start date must be before the end date' };

  const earliest = ceilHour(
    new Date(now.getTime() - MAX_WINDOW_DAYS * 24 * 3600_000),
  );
  if (start.getTime() < earliest.getTime())
    return {
      error: `the API only serves the last ${MAX_WINDOW_DAYS} days — earliest is ${stamp(earliest)}`,
    };

  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return {
    window: {
      fromISO: start.toISOString(),
      toISO: end.toISOString(),
      hours: minutes / 60,
      minutes,
      granularityMinutes: granularityFor(minutes),
      label: `${stamp(start)} - ${stamp(new Date(end.getTime() - 1))}`,
    },
  };
}

/** The rolling default: the last `minutes` up to now, aligned to what the API will accept. */
export function rollingMinutes(
  minutes: number,
  now: Date,
  label?: string,
): Window {
  const g = granularityFor(minutes);
  const end = ceilTo(now, g);
  const start = new Date(end.getTime() - minutes * 60_000);
  return {
    fromISO: start.toISOString(),
    toISO: end.toISOString(),
    hours: minutes / 60,
    minutes,
    granularityMinutes: g,
    label: label ?? (minutes < 60 ? `last ${minutes}m` : `last ${minutes / 60}h`),
  };
}

/** The rolling default: the last `hours` up to now. */
export function rollingWindow(hours: number, now: Date): Window {
  return rollingMinutes(hours * 60, now, `last ${hours}h`);
}
