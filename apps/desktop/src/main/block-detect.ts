/**
 * Pure decisions behind the local stand-in screen: whether a response was refused at the
 * edge rather than served, and how long to wait before checking again. Electron-free so
 * they're unit-testable; blocked-overlay.ts applies the result to the view.
 */

/** Why the local screen is up. */
export type BlockReason = 'blocked' | 'offline' | 'unreachable';

/** The parts of a webRequest response the refusal check reads. */
export interface ResponseFacts {
  statusCode: number;
  resourceType: string;
  responseHeaders?: Record<string, string[]>;
}

const MITIGATED = 'x-vercel-mitigated';

/** Reads a header case-insensitively from webRequest's array-valued map. */
function header(
  headers: Record<string, string[]> | undefined,
  name: string,
): string {
  if (!headers) return '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key]?.[0] ?? '';
  }
  return '';
}

/**
 * True when the edge refused this response outright.
 *
 * A challenge is deliberately NOT a refusal: it is solvable by a real browser and this
 * view is one, so covering it would hide the only way back. A 403 on a document counts
 * even without the header, since the app itself never answers a page request that way.
 */
export function isEdgeDenied(facts: ResponseFacts): boolean {
  if (facts.statusCode !== 403) return false;
  const mitigated = header(facts.responseHeaders, MITIGATED).toLowerCase();
  if (mitigated === 'challenge') return false;
  return mitigated === 'deny' || facts.resourceType === 'mainFrame';
}

/**
 * True when a probe's own response shows we are still being refused.
 *
 * A challenge arrives as its own status rather than a 403 (measured against production),
 * so it reads as clear here on purpose: the page is a browser and can answer one, which
 * this check cannot.
 */
export function probeStillDenied(
  status: number,
  mitigated: string | null,
): boolean {
  return status === 403 && (mitigated ?? '').toLowerCase() !== 'challenge';
}

// Refusals clear on their own clock, so checking often buys nothing; a dropped connection
// can come back any second, so those start fast. Both hold at their last step.
const SCHEDULES: Record<BlockReason, readonly number[]> = {
  blocked: [20_000, 30_000, 45_000, 60_000],
  offline: [2_000, 4_000, 8_000, 15_000, 30_000],
  unreachable: [2_000, 5_000, 10_000, 20_000, 30_000],
};

/** Delay before the nth automatic check (0-based), holding at the schedule's last step. */
export function probeDelayMs(reason: BlockReason, attempt: number): number {
  const steps = SCHEDULES[reason];
  const i = Math.min(Math.max(Math.trunc(attempt) || 0, 0), steps.length - 1);
  return steps[i] as number;
}

// One flag per state, in the order they are honoured when more than one is set.
const SIMULATE_FLAGS: readonly (readonly [string, BlockReason])[] = [
  ['DESKTOP_SIMULATE_RATE_LIMIT', 'blocked'],
  ['DESKTOP_SIMULATE_OFFLINE', 'offline'],
  ['DESKTOP_SIMULATE_UNREACHABLE', 'unreachable'],
];

/**
 * The state a dev flag is asking for, or null for none. "0" and "false" read as off, so a
 * flag left set to something falsy in a shell profile does not quietly hold the screen up.
 */
export function simulatedReason(
  env: Record<string, string | undefined>,
): BlockReason | null {
  for (const [key, reason] of SIMULATE_FLAGS) {
    const value = env[key];
    if (value && value !== '0' && value !== 'false') return reason;
  }
  return null;
}
