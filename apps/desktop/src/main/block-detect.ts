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
const CONTENT_TYPE = 'content-type';

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
 * True when this response was refused rather than served.
 *
 * A challenge is deliberately not a refusal: it is solvable by a real browser and this view
 * is one, so covering it would hide the only way back.
 */
export function isEdgeDenied(facts: ResponseFacts): boolean {
  if (facts.statusCode !== 403) return false;
  const mitigated = header(facts.responseHeaders, MITIGATED).toLowerCase();
  if (mitigated === 'challenge') return false;
  return mitigated === 'deny' || facts.resourceType === 'mainFrame';
}

/**
 * True when the document itself came back as a server error page.
 *
 * The app never answers a page request with a 5xx, so one means something in front of it
 * did: a proxy with nothing behind it, or the platform's own error page. Unlike a refused
 * connection this LOADS — status, body, dom-ready and all — so nothing else in the shell
 * notices, and the window is handed over to someone else's error page with no way off it.
 *
 * Two narrowings, each ruling out a case that is not "the site is down":
 *
 * - Documents only. A single failing RPC is the page's own problem to report, and a map
 *   tile that 502s is not grounds for covering the whole window.
 * - It has to carry a page. The app's own file routes answer a bad deploy with a bodiless
 *   500 and no content type at all, and an installer link that lands on one is a failed
 *   download over a working app — covering that would take the app away over it. Every
 *   real error page carries text/html: the platform's, and the dev proxy's (measured).
 *
 * A 5xx counting as unreachable matches what the recovery probe already decides about one,
 * so the way in and the way back cannot disagree about what counts as reachable.
 */
export function isServerError(facts: ResponseFacts): boolean {
  if (facts.resourceType !== 'mainFrame' || facts.statusCode < 500)
    return false;
  return header(facts.responseHeaders, CONTENT_TYPE)
    .toLowerCase()
    .startsWith('text/html');
}

/**
 * True when a document came back as "there is nothing here" from something that is not the
 * app.
 *
 * A 404 is normally a real page — a company slug that no longer exists renders the app's
 * own not-found, with working navigation — so this cannot key on the status alone. What
 * separates the two is whether the app has proved it can serve a document at all: the dev
 * proxy with nothing behind it answers 404 to everything, including the very first load,
 * and no failure event fires because a 404 with a body is a successful load. `served` is
 * that proof, and the caller carries it.
 */
export function isMissingApp(facts: ResponseFacts, served: boolean): boolean {
  if (served || facts.resourceType !== 'mainFrame' || facts.statusCode !== 404)
    return false;
  return header(facts.responseHeaders, CONTENT_TYPE)
    .toLowerCase()
    .startsWith('text/html');
}

/**
 * True when a check's own response shows we are still being refused.
 *
 * A challenge reads as clear on purpose: the page is a browser and can answer one, which
 * this check cannot.
 */
export function probeStillDenied(
  status: number,
  mitigated: string | null,
): boolean {
  return status === 403 && (mitigated ?? '').toLowerCase() !== 'challenge';
}

// A dropped connection can come back any second; the other states cannot. Every schedule
// holds at its last step rather than growing without bound.
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
