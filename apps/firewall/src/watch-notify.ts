// Telling a human, without telling them the same thing every hour.
//
// A watch that runs unattended has one failure mode that matters more than missing something:
// repeating itself until it is ignored. So a notification is sent when the actionable set CHANGES,
// not whenever it is non-empty — a finding that is still there next hour is not news.

import { readFile, writeFile } from 'node:fs/promises';

import { errMsg } from './util';
import type { WatchReport } from './watch';

/** Beside the log, and gitignored with it. */
/**
 * How long a delivered notification silences an identical one. Matched to the investigation
 * memory in `readInvestigated` so the two decay together — they were 7 days and forever.
 */
export const NOTIFY_MEMORY_MS = 7 * 24 * 60 * 60_000;

export const NOTIFY_STATE = '.firewall-watch-state';

/**
 * What is worth waking someone for, as a stable string.
 *
 * Deliberately excludes counts and windows: the same fingerprint seen again with a different
 * request total is the same news. Only a different identity, verdict, or fault is new.
 */
export function actionableKey(r: WatchReport): string {
  return [
    ...r.findings
      .filter((f) => f.advice.verdict === 'ban')
      .map((f) => `ban:${f.digest.toLowerCase()}`)
      .sort(),
    ...r.enforcement.map((e) => `enforce:${e}`).sort(),
    ...r.errors.map((e) => `error:${e}`).sort(),
    ...(r.truncated && r.fingerprints === 0 ? ['truncated:blind'] : []),
  ].join('|');
}

/**
 * The same, for the investigated path.
 *
 * Namespaced, because a run with --investigate and one without share this state file and
 * `ban:<digest>` would mean two different things in it — each looking like news to the other.
 */
export function concludedKey(concluded: readonly string[]): string {
  return concluded.length
    ? [...concluded]
        .sort()
        .map((c) => `concluded:${c}`)
        .join('|')
    : '';
}

/** One line for a conclusion. Says which way it went: `unclear` is not the same as `ban`. */
export function concludedText(concluded: readonly string[]): string {
  const bans = concluded.filter((c) => c.startsWith('ban:')).length;
  const unclear = concluded.length - bans;
  const parts: string[] = [];
  if (bans) parts.push(`${bans} fingerprint(s) Claude says to deny`);
  if (unclear) parts.push(`${unclear} inconclusive`);
  return parts.join(', ') || 'nothing conclusive';
}

/** Recipient for the iMessage — a phone number or Apple ID, kept in .env.local. */
export const IMESSAGE_TO = 'FW_NOTIFY_IMESSAGE';

/**
 * `osascript` argv that sends an iMessage.
 *
 * The handle and body are passed as ARGUMENTS, never interpolated into the script text. An
 * apostrophe in a rule name would otherwise terminate the AppleScript string and turn a
 * notification into a syntax error — silently, since nobody reads a notifier's stderr.
 *
 * No account is selected. Messages picks one, and the obvious `1st account whose service type =
 * iMessage` throws on macOS 26 — `service type` is in the scripting dictionary but its handler
 * fails. Verified working 2026-08-06 on 26.5.2.
 *
 * Requires Messages to be signed in, and Automation permission for whatever runs this. A launchd
 * agent cannot show that prompt, so grant it once from a terminal run.
 */
export function iMessageArgs(handle: string, body: string): string[] {
  return [
    '-e',
    [
      'on run argv',
      '  tell application "Messages"',
      '    send (item 2 of argv) to participant (item 1 of argv)',
      '  end tell',
      'end run',
    ].join('\n'),
    handle,
    body,
  ];
}

/** One line a human reads on a lock screen — never a digest, which is unreadable there anyway. */
export function notifyText(r: WatchReport): string {
  const bans = r.findings.filter((f) => f.advice.verdict === 'ban').length;
  const parts: string[] = [];
  if (bans) parts.push(`${bans} fingerprint(s) worth denying`);
  if (r.enforcement.length)
    parts.push(`${r.enforcement.length} rule(s) not enforcing`);
  if (r.errors.length) parts.push(`${r.errors.length} error(s)`);
  if (r.truncated && r.fingerprints === 0)
    parts.push('screen was truncated and saw nothing');
  return parts.join(', ') || 'something wants a human';
}

/** Digests already investigated, so an hourly job cannot pay for the same answer twice. */
export const INVESTIGATED = '.firewall-watch-investigated';

/**
 * What has already been investigated, dropping anything older than `keepMs`.
 *
 * Decay matters both ways: a fingerprint that returns next week deserves a fresh look, and
 * without it the file grows for the life of the machine. An unreadable file yields nothing, which
 * re-investigates rather than skipping — paying twice is the cheaper mistake.
 */
export async function readInvestigated(
  dir: string,
  now: number,
  keepMs = 7 * 24 * 60 * 60_000,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const raw = await readFile(`${dir}/${INVESTIGATED}`, 'utf8');
    for (const line of raw.split('\n')) {
      const [digest, at] = line.trim().split('|');
      const t = Number(at);
      if (digest && Number.isFinite(t) && now - t < keepMs)
        out.set(digest.toLowerCase(), t);
    }
  } catch {
    // Deliberately empty — see above.
  }
  return out;
}

/** Persist it. Never throws: losing this costs a repeat investigation, not a missed one. */
export async function writeInvestigated(
  dir: string,
  seen: ReadonlyMap<string, number>,
): Promise<void> {
  try {
    await writeFile(
      `${dir}/${INVESTIGATED}`,
      [...seen].map(([d, t]) => `${d}|${t}`).join('\n'),
      'utf8',
    );
  } catch {
    // Deliberately empty.
  }
}

/**
 * Whether to notify now: there is something actionable AND it differs from last time.
 *
 * An unreadable state file means notify. Staying quiet because we could not remember is the one
 * outcome that turns a missed read into a missed scraper.
 */
export async function shouldNotify(
  dir: string,
  key: string,
  now = Date.now(),
  maxAgeMs = NOTIFY_MEMORY_MS,
): Promise<boolean> {
  if (!key) return false;
  try {
    const raw = (await readFile(`${dir}/${NOTIFY_STATE}`, 'utf8')).trim();
    const [at, ...rest] = raw.split('\n');
    const stamped = Number(at);
    // Old format (key only, no stamp) is treated as expired: re-reporting once is the cheap
    // mistake, and the alternative is a key from an unknown time silencing a live finding.
    if (!Number.isFinite(stamped) || !rest.length) return true;
    // Decays with the investigation memory. Without this the two disagreed: a fingerprint gone
    // for eight days had its INVESTIGATED entry expire, so it was investigated again and PAID
    // for again — and then matched a notification key that never expired, so the answer was
    // silently never delivered. "Still here this hour" is not news; "went away and came back" is.
    if (now - stamped > maxAgeMs) return true;
    return rest.join('\n') !== key;
  } catch {
    return true;
  }
}

/** Remember what was reported. Never throws: losing the memory costs a repeat, not a miss. */
export async function rememberNotified(
  dir: string,
  key: string,
  now = Date.now(),
): Promise<void> {
  try {
    await writeFile(`${dir}/${NOTIFY_STATE}`, `${now}\n${key}`, 'utf8');
  } catch {
    // Deliberately swallowed.
  }
}

/**
 * Send one. Returns null on delivery, or the reason it failed.
 *
 * Never throws, and never reports success it did not get: a notifier that fails quietly turns
 * the whole watch into a machine that looks like it is working.
 */
/** Ceiling on one notification. Generous for a GUI call, finite so it cannot outlive the tick. */
export const NOTIFY_TIMEOUT_MS = 20_000;

export async function notify(body: string): Promise<string | null> {
  if (process.platform !== 'darwin')
    return 'notifications are macOS-only; nothing was sent';
  const to = process.env[IMESSAGE_TO]?.trim();
  const argv = to
    ? iMessageArgs(to, body)
    : [
        '-e',
        `display notification ${JSON.stringify(body)} with title "firewall watch" sound name "Submarine"`,
      ];
  try {
    const proc = Bun.spawn(['osascript', ...argv], {
      stdout: 'ignore',
      stderr: 'pipe',
      // Bounded for the same reason the investigation is: this runs on the unattended path, and
      // `await proc.exited` on a wedged osascript blocks the loop that is guarding the site — a
      // watch that stops screening and never says so. A notification is worth seconds, not a
      // night.
      timeout: NOTIFY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const [err, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      return `notification failed (${code}): ${err.trim().slice(0, 160)}`;
    return null;
  } catch (e) {
    return `notification could not be sent: ${errMsg(e)}`;
  }
}
