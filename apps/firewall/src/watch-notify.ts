// Telling a human, without telling them the same thing every hour.
//
// A watch that runs unattended has one failure mode that matters more than missing something:
// repeating itself until it is ignored. So a notification is sent when the actionable set CHANGES,
// not whenever it is non-empty — a finding that is still there next hour is not news.

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { recommendsAction } from './ban-advice';
import { envText } from './env';
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
      .filter((f) => recommendsAction(f.advice.verdict))
      // Keyed by VERDICT as well as digest, so an identity that hardens from challenge to deny is
      // news rather than the same news. Hard-coding `ban:` here would have silenced exactly that.
      .map((f) => `${f.advice.verdict}:${f.digest.toLowerCase()}`)
      .sort(),
    ...r.enforcement.map((e) => `enforce:${e}`).sort(),
    ...r.reachability.map((e) => `reach:${e}`).sort(),
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

/**
 * Enough of a digest to recognise on a phone: the JA4_a profile, which carries the ALPN slot and
 * is the part an operator reads, plus a tail to disambiguate siblings sharing a cipher hash.
 */
export function shortDigest(digest: string): string {
  const d = digest.trim();
  return d.length <= 22 ? d : `${d.slice(0, 10)}…${d.slice(-8)}`;
}

/**
 * One line for a conclusion, naming WHICH identity.
 *
 * It used to say only "1 inconclusive", which tells a phone that something happened and nothing
 * about what — and the whole reason this path exists is that nobody is reading stdout. The
 * digest is the one field worth carrying: it is shape-checked upstream, it is not
 * client-authored prose, and without it the message cannot be acted on without opening a laptop.
 *
 * `unclear` is not a quieter `ban`. It means the investigation ran and could not decide, which
 * needs a human exactly as much.
 */
export function concludedText(concluded: readonly string[]): string {
  const named = (prefix: string) =>
    concluded
      .filter((c) => c.startsWith(prefix))
      .map((c) => shortDigest(c.slice(prefix.length)));
  const bans = named('ban:');
  const challenges = named('challenge:');
  const unclear = named('unclear:');
  const parts: string[] = [];
  if (bans.length) parts.push(`DENY ${bans.join(', ')}`);
  // Named distinctly from a deny: they go on different lists and cost different things to be
  // wrong about, and a phone message that blurs them invites the harsher one being applied.
  if (challenges.length) parts.push(`CHALLENGE ${challenges.join(', ')}`);
  if (unclear.length) parts.push(`inconclusive ${unclear.join(', ')}`);
  if (!parts.length) return 'nothing conclusive';
  return `${parts.join(' · ')} — see firewall-watch.log`;
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
  const challenges = r.findings.filter(
    (f) => f.advice.verdict === 'challenge',
  ).length;
  const parts: string[] = [];
  if (bans) parts.push(`${bans} fingerprint(s) worth denying`);
  if (challenges) parts.push(`${challenges} worth challenging`);
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
  // Write-then-rename, like saveList: this file is what stops a digest being investigated twice,
  // and an investigation costs money. A truncated write loses entries, and every lost entry is
  // one the next tick pays to rediscover.
  const tmp = `${dir}/${INVESTIGATED}.tmp-${process.pid}`;
  try {
    await writeFile(
      tmp,
      [...seen].map(([d, t]) => `${d}|${t}`).join('\n'),
      'utf8',
    );
    await rename(tmp, `${dir}/${INVESTIGATED}`);
  } catch {
    // Best-effort, as before — but never leave the temp file behind.
    await unlink(tmp).catch(() => undefined);
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
  const to = envText(IMESSAGE_TO);
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
