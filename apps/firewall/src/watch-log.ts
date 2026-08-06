// Watch mode's log. The loop runs while you are looking at something else, so anything it did
// while your back was turned has to survive being missed — including, especially, the runs that
// found nothing and the ones that failed. A log that only records the interesting events cannot
// answer "was it even running?", which is the first question anyone asks of a background loop.

import { appendFile } from 'node:fs/promises';

/** Repo root, gitignored. Read it with `tail -f firewall-watch.log`. */
export const WATCH_LOG = 'firewall-watch.log';

export type WatchEvent =
  | { kind: 'armed'; hours: number; everyMin: number }
  | { kind: 'disarmed' }
  | { kind: 'screen'; fingerprints: number; profiled: number; bans: number }
  | {
      kind: 'invoke';
      digest: string;
      allowed: number;
      total: number;
      reasons: string[];
    }
  | { kind: 'verdict'; digest: string; text: string; provenance: string }
  | { kind: 'failed'; digest: string; error: string }
  | { kind: 'error'; error: string };

/** Indented so a multi-line verdict cannot be mistaken for a run of separate events. */
function block(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

/**
 * Wall-clock `HH:MM` on the operator's own clock, for the status line.
 *
 * The log above is UTC and says so with a `Z`, because a record read days later from anywhere
 * must not be ambiguous. This is the opposite case: it is read at a glance beside a real clock,
 * where UTC is just silently wrong by an hour for most of the British year.
 *
 * Built from the local getters rather than `toLocaleTimeString`, whose output varies by locale
 * and can render midnight as `24:00`.
 */
export function clockTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** One event as it appears in the log. Ends with a newline, so callers only append. */
export function logEntry(at: Date, e: WatchEvent): string {
  const t = `${at.toISOString().slice(0, 19)}Z`;
  const head = (kind: string, rest: string) =>
    `${t}  ${kind.padEnd(8)} ${rest}`;
  switch (e.kind) {
    case 'armed':
      return `${head('armed', `${e.hours}h window, screening every ${e.everyMin}m`)}\n`;
    case 'disarmed':
      return `${head('disarmed', '')}\n`;
    case 'screen':
      return `${head('screen', `${e.fingerprints} allowed through · ${e.profiled} profiled · ${e.bans} would ban`)}\n`;
    case 'invoke':
      return [
        head(
          'INVOKE',
          `claude on ${e.digest} — ${e.allowed} allowed of ${e.total}`,
        ),
        ...e.reasons.map((r) => `    why: ${r}`),
        '',
      ].join('\n');
    case 'verdict':
      return `${head('verdict', `${e.digest}  [${e.provenance}]`)}\n${block(e.text)}\n`;
    case 'failed':
      return `${head('FAILED', `${e.digest} — ${e.error}`)}\n`;
    case 'error':
      return `${head('ERROR', e.error)}\n`;
  }
}

/**
 * Append one event. Never throws: the watch losing its log is worth a missing line, not a dead
 * loop — and the loop is the thing actually guarding the site.
 */
export async function logWatch(
  dir: string,
  at: Date,
  e: WatchEvent,
): Promise<void> {
  try {
    await appendFile(`${dir}/${WATCH_LOG}`, logEntry(at, e), 'utf8');
  } catch {
    // Deliberately swallowed. The on-screen state is the primary channel; this is the record.
  }
}
