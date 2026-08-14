// Watch mode: the unattended loop. Armed with `v`, it screens on its own timer whatever pane is
// open, investigates anything that clears the bar, and notifies. Lifted out of the container
// because it is the path nobody is looking at when it runs.

import { useEffect, useRef, useState } from 'react';

import { rollingWindow } from '../time-window';
import { watchHours, watchIntervalMs, watchTiming } from '../tuning';
import { errMsg } from '../util';
import { adviceWhy, logShadow, screenOnce, watchlistAdditions } from '../watch';
import { clockTime, logWatch } from '../watch-log';
import {
  caffeinateArgs,
  canKeepAwake,
  fingerprintConfig,
  investigationChangedConfig,
  recentSpawns,
  runInvestigation,
  shouldInvestigate,
  verdictFrom,
} from '../watch-mode';
import {
  concludedKey,
  concludedText,
  notify,
  readInvestigated,
  rememberNotified,
  shouldNotify,
  writeInvestigated,
} from '../watch-notify';
import type { WatchlistEntry } from '../watchlist';
import { recordAdditions, WATCHLIST_FILE } from '../watchlist';
import { ENV_PATH } from './useDenylist';
import type { Creds } from './useIpTabs';

const VERDICT_LINES = 12; // rendered inline; the rest stays in the log

/** One identity a tick judged. Reported in parts, because how much of it fits is the panel's problem. */
export type Profiled = {
  digest: string;
  total: number;
  verdict: string;
  /** The tells behind the verdict. Shown only where there is room; the log always has it. */
  why: string;
};

export type Watch = {
  on: boolean;
  toggle: () => void;
  busy: boolean;
  /** Clock time of the last completed screen. */
  at: string;
  /** Whether the machine is being held awake for the loop. */
  keepingAwake: boolean;
  note: string;
  /** Every identity the last tick profiled — "1 profiled" alone sends you to the log. */
  who: Profiled[];
  invokedAt: string;
  invokedCount: number;
  notifiedAt: string;
  /** The investigation text, clamped to what the pane reserves room for. */
  verdictHead: string;
  /** Lines of it not shown; the log has the rest verbatim. */
  verdictClipped: number;
  /** Which identity the verdict belongs to. Without it the pane renders the PREVIOUS conclusion under a generic heading while a new investigation runs. */
  verdictOf: string;
};

export function useWatch(opts: {
  creds: Creds;
  /** Whatever the tick judged, so the watch-list pane stays current while it runs. */
  onWatchlist: (entries: WatchlistEntry[]) => void;
}): Watch {
  const { creds, onWatchlist } = opts;
  // Through a ref: the effect is armed once, so the callback captured then would be the one used
  // for the whole session.
  const onWatchlistRef = useRef(onWatchlist);
  onWatchlistRef.current = onWatchlist;
  // Watch mode. Runs off the app's own timer whatever pane is open, since the point is to be
  // left running. State lives in refs where the loop reads it: the effect is armed once and its
  // closure would otherwise keep whatever the values were at arming.
  const [watchOn, setWatchOn] = useState(false);
  const [watchNote, setWatchNote] = useState('');
  // Who the last tick actually profiled, one line each — the note above only counts them.
  const [watchWho, setWatchWho] = useState<Profiled[]>([]);
  const [watchAt, setWatchAt] = useState('');
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchVerdict, setWatchVerdict] = useState('');
  // Which identity the verdict above belongs to. Without it the pane renders the PREVIOUS
  // conclusion under a generic heading while a new investigation runs, and an operator acting
  // on it acts on the wrong fingerprint.
  const [watchVerdictOf, setWatchVerdictOf] = useState('');
  // Kept even after the verdict is read: an invocation happened whether or not anyone was
  // looking at this pane when it did.
  const [invokedAt, setInvokedAt] = useState('');
  const [invokedCount, setInvokedCount] = useState(0);
  const [notifiedAt, setNotifiedAt] = useState('');
  const [keepingAwake, setKeepingAwake] = useState(false);
  const investigatedRef = useRef<Set<string>>(new Set());
  /** Conclusions that were reached but not delivered. Retried before each screen. */
  const pendingNotifyRef = useRef<{ key: string; text: string }[]>([]);
  const spawnsRef = useRef<number[]>([]);
  // The investigation child, so disarm and unmount can stop it. A hung one would otherwise
  // outlive the loop and every later screen would queue behind it.
  const investigationRef = useRef<{ kill: () => void } | null>(null);

  // Enough to carry a verdict and its first reasons; the log has the rest verbatim.
  const verdictLines = watchVerdict ? watchVerdict.trimEnd().split('\n') : [];
  const verdictHead = verdictLines.slice(0, VERDICT_LINES).join('\n');
  const verdictClipped = Math.max(0, verdictLines.length - VERDICT_LINES);
  // Watch mode's loop. Deliberately not gated on `pane`, unlike the live refresh above: this is
  // meant to be armed and left alone while you work in another pane.
  useEffect(() => {
    if (!watchOn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const root = process.cwd();
    // A loop that wakes every fifteen minutes is precisely what idle sleep suspends, so arming
    // the watch has to hold the machine up. Failing to start it is not fatal: a watch that runs
    // and may be suspended still beats no watch, and the status line says which one you have.
    let awake: ReturnType<typeof Bun.spawn> | null = null;
    if (watchTiming() !== null && canKeepAwake(process.platform)) {
      try {
        awake = Bun.spawn(['caffeinate', ...caffeinateArgs(process.pid)], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
      } catch {
        awake = null;
      }
    }
    setKeepingAwake(Boolean(awake));
    if (watchTiming() !== null)
      void logWatch(root, new Date(), {
        kind: 'armed',
        hours: watchHours(),
        everyMin: watchIntervalMs() / 60_000,
      });

    /**
     * Deliver anything a previous tick concluded but could not send.
     *
     * The digest is already in `investigatedRef`, so the conclusion will never be re-derived —
     * without this, one transient notification failure drops the alert for the whole session,
     * after the investigation has already been paid for.
     */
    const flushPending = async () => {
      for (const p of [...pendingNotifyRef.current]) {
        if (stopped) return;
        const failed = await notify(p.text);
        if (failed) continue;
        await rememberNotified(root, p.key);
        pendingNotifyRef.current = pendingNotifyRef.current.filter(
          (q) => q.key !== p.key,
        );
        setNotifiedAt(clockTime(new Date()));
      }
    };

    /** One screen, plus an investigation for anything that clears the bar. */
    const tick = async () => {
      // Guarded, not assumed: watchHours() throws when unconfigured, and an unhandled throw in
      // here kills the loop silently rather than saying why.
      if (watchTiming() === null) {
        setWatchNote(
          'FW_WATCH_HOURS / FW_WATCH_INTERVAL_MIN are not set — nothing screened',
        );
        setWatchBusy(false);
        return;
      }
      setWatchBusy(true);
      try {
        // Inside the try, deliberately: it notifies and writes files, and outside it one failure
        // rejected tick(), which skipped the reschedule below and killed the loop for good.
        await flushPending();
        // Seeded from disk every tick, not only written to it. The in-memory set starts empty on
        // each arm, so a digest investigated yesterday was investigated again on restart — paying
        // for an answer the SHARED notify state then suppressed as already sent. Re-reading also
        // picks up anything the CLI investigated between ticks.
        for (const d of (await readInvestigated(root, Date.now())).keys())
          investigatedRef.current.add(d);
        // Every gate — denylist, first-party rules, bot allowlist — is assembled by screenOnce,
        // which the CLI uses too. Assembling them here is what let this loop drift three times.
        const { rows, findings, truncated, configErrors } = await screenOnce(
          creds,
          rollingWindow(watchHours(), new Date()),
        );
        if (stopped) return;
        setWatchAt(clockTime(new Date()));
        await logShadow(root, findings);
        // Whatever was judged goes on the watch list, so "who was that?" survives the tick.
        if (findings.length) {
          const listed = await recordAdditions(
            root,
            WATCHLIST_FILE,
            watchlistAdditions(findings),
            new Date(),
          );
          if (listed.error)
            void logWatch(root, new Date(), {
              kind: 'error',
              error: `watch list: ${listed.error}`,
            });
          else if (listed.entries && !stopped)
            onWatchlistRef.current(listed.entries);
        }
        // Re-checked after the awaits above, like the check before them: logShadow and
        // recordAdditions both touch disk, and a disarm landing in that window otherwise repaints
        // the panel of a loop the operator has switched off.
        if (stopped) return;
        setWatchWho(
          findings.map((f) => ({
            digest: f.digest,
            total: f.total,
            verdict: f.advice.verdict,
            why: adviceWhy(f.advice),
          })),
        );
        const bans = findings.filter((f) => f.advice.verdict === 'ban');
        // Truncation is carried, not dropped. A capped screen that surfaced nothing is BLIND, and
        // rendering that as "0 allowed through" is a quiet night the tool never actually had.
        const blind = truncated && rows.length === 0;
        setWatchNote(
          [
            `${rows.length} fingerprint(s) allowed through · ${findings.length} profiled · ${bans.length} would ban`,
            truncated ? '· TRUNCATED, rows may be missing' : '',
            blind ? '· BLIND, not quiet' : '',
            configErrors.length
              ? `· ${configErrors.length} config error(s)`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
        for (const e of configErrors)
          void logWatch(root, new Date(), { kind: 'error', error: e });
        // Logged even when it finds nothing: otherwise the log cannot tell "ran and was quiet"
        // apart from "never ran", which is the first thing you want to know of a background loop.
        void logWatch(root, new Date(), {
          kind: 'screen',
          fingerprints: rows.length,
          profiled: findings.length,
          bans: bans.length,
          profiledWho: findings.map((f) => ({
            digest: f.digest,
            allowed: f.allowed,
            total: f.total,
            verdict: f.advice.verdict,
            why: adviceWhy(f.advice),
          })),
        });

        const now = Date.now();
        spawnsRef.current = recentSpawns(spawnsRef.current, now);
        // BEFORE the early return below. A truncated-blind screen, or a config error such as
        // the live-firewall read failing every tick, produces no candidate at all — so the
        // return meant those alarms never reached the phone. That is the same either/or split
        // the CLI's --notify was fixed to stop making, and it survived on the path where nobody
        // is reading the screen.
        const alarms = [
          truncated && rows.length === 0
            ? 'screen was BLIND: truncated with nothing surfaced'
            : '',
          ...configErrors,
        ].filter(Boolean);
        if (alarms.length) {
          const key = `alarm:${alarms.join('|')}`;
          if (!stopped && (await shouldNotify(root, key))) {
            // Rechecked AFTER the await, like the conclusion path below: shouldNotify reads a
            // file, and a disarm landing in that window otherwise still sends the message.
            if (stopped) return;
            const failed = await notify(alarms.join(' · '));
            // Appended: replacing it threw away the screen's own result — how many were allowed
            // through, and whether it was BLIND.
            if (failed) setWatchNote((n) => (n ? `${n} · ${failed}` : failed));
            else {
              await rememberNotified(root, key);
              setNotifiedAt(clockTime(new Date()));
            }
          }
        }

        const next = findings.find((f) =>
          shouldInvestigate(f, investigatedRef.current, spawnsRef.current, now),
        );
        if (!next || stopped) return;

        // Persisted, not just in-process. investigatedRef alone meant a TUI restart re-bought an
        // investigation whose verdict the SHARED notify state then suppressed as already sent —
        // paying for an answer nobody would be told. The file is the same one the CLI uses.
        investigatedRef.current.add(next.digest.toLowerCase());
        const persisted = await readInvestigated(root, Date.now());
        persisted.set(next.digest.toLowerCase(), Date.now());
        await writeInvestigated(root, persisted);
        // Stamped HERE, not from the `now` taken before the alarm and investigated-state awaits.
        // notify() is a network call, so that value can be seconds stale by the time the spawn
        // actually happens, and the rate limiter then treats this investigation as older than it
        // is — letting the next paid one through early.
        spawnsRef.current = [...spawnsRef.current, Date.now()];
        setInvokedAt(clockTime(new Date()));
        setInvokedCount((n) => n + 1);
        setWatchNote(`invoked claude on ${next.digest}…`);
        // Cleared before the new run, not after it: the gap is exactly when the stale one shows.
        setWatchVerdict('');
        setWatchVerdictOf(next.digest);
        void logWatch(root, new Date(), {
          kind: 'invoke',
          digest: next.digest,
          allowed: next.allowed,
          total: next.total,
          reasons: next.advice.reasons,
        });
        // Repo root, so the spawned agent finds .claude/skills/firewall-operator and the
        // firewall commands resolve. The TUI is already launched from there.
        // The same check the CLI wraps around this call. --disallowed-tools cannot stop a ban:
        // adding one is an append plus an apply, and Bash has to stay available for the
        // protocol's read-only queries. Unchecked here, a spawned agent that wrote one went
        // unnoticed on the unattended path specifically.
        // The same constant useDenylist writes through, not a path rebuilt from cwd: run from
        // anywhere but the repo root and the tamper check would fingerprint a different file.
        const envPath = ENV_PATH;
        const beforeCfg = await fingerprintConfig(envPath);
        // A property, not a local: TypeScript narrows a callback-assigned local to `never` across
        // the await, so the comparison below could not be written against it.
        const spawned: { child: { kill: () => void } | null } = { child: null };
        const out = await runInvestigation(
          next,
          process.cwd(),
          watchHours(),
          (c) => {
            spawned.child = c;
            // A child arriving after disarm has nobody left to stop it.
            if (stopped) c.kill();
            else investigationRef.current = c;
          },
        );
        // Only if it still points at OUR child. A disarm-and-rearm during the await leaves this
        // continuation running while the new effect has already stored its own handle, and
        // clearing unconditionally strands that child with nothing able to kill it.
        if (investigationRef.current === spawned.child)
          investigationRef.current = null;
        if (
          investigationChangedConfig(
            beforeCfg,
            await fingerprintConfig(envPath),
          )
        ) {
          const alarm = `.env.local CHANGED during the investigation of ${next.digest} — the run was told not to apply anything.`;
          // Note guarded, log not — the same split the other writers use. A disarm mid-await must
          // not paint a status onto a loop that is off, but the change genuinely happened.
          if (!stopped) setWatchNote(alarm);
          void logWatch(root, new Date(), { kind: 'error', error: alarm });
        }
        if (stopped) return;
        setWatchVerdict(
          out.ok ? out.verdict : `investigation failed: ${out.error}`,
        );
        setWatchVerdictOf(next.digest);
        setWatchNote(
          out.ok
            ? `investigated ${next.digest} — read it below`
            : `investigation failed for ${next.digest}`,
        );
        void logWatch(
          root,
          new Date(),
          out.ok
            ? {
                kind: 'verdict',
                digest: next.digest,
                text: out.verdict,
                provenance: out.provenance,
              }
            : { kind: 'failed', digest: next.digest, error: out.error },
        );

        // The pane above only helps while someone is looking at it. This is the path that reaches
        // you when nobody is, so it fires on what the investigation CONCLUDED, not on the screen's
        // suspicion. `unclear` counts: an answer nobody can read is not an answer of "fine".
        const verdict = out.ok ? verdictFrom(out.verdict) : 'unclear';
        if (verdict !== 'leave') {
          const conclusion = [`${verdict}:${next.digest.toLowerCase()}`];
          const key = concludedKey(conclusion);
          // Shared with the CLI, on purpose: whichever path saw it first, the other stays quiet,
          // and quitting the TUI no longer re-notifies about the same fingerprint.
          if (await shouldNotify(root, key)) {
            // Checked BEFORE sending, not after. shouldNotify awaits a file read, and a disarm
            // landing in that window otherwise still fires the message.
            if (stopped) return;
            const failed = await notify(concludedText(conclusion));
            if (stopped) return;
            if (failed) {
              // Retained for the next tick. The digest is already in investigatedRef, so without
              // this the conclusion is never re-derived and one transient failure silently drops
              // the alert for the whole session — after paying for the investigation.
              pendingNotifyRef.current = [
                ...pendingNotifyRef.current.filter((p) => p.key !== key),
                { key, text: concludedText(conclusion) },
              ];
              setWatchNote(`${failed} — will retry`);
            } else {
              await rememberNotified(root, key);
              setNotifiedAt(clockTime(new Date()));
            }
          }
        }
      } catch (e) {
        // A failed screen must not read as a quiet one. The whole point of the mode is that
        // silence means "nothing found", so silence has to be earned.
        if (!stopped) setWatchNote(`watch failed: ${errMsg(e)}`);
        void logWatch(root, new Date(), { kind: 'error', error: errMsg(e) });
      } finally {
        setWatchBusy(false);
      }
    };

    // setTimeout, not setInterval: a tick that outruns the period must not queue another behind
    // it — a screen plus an investigation can take minutes.
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          await tick();
        } catch (e) {
          // A tick that threw past its own handler must not take the loop with it. Silence is
          // what this mode reports as "nothing found", so a dead loop reads as a quiet night.
          // The note is guarded but the log is not, matching the handler inside tick(): a
          // failure after disarm must not paint a status onto a loop the operator switched off,
          // and it still genuinely happened, so the log is where it belongs.
          if (!stopped) setWatchNote(`watch tick failed: ${errMsg(e)}`);
          void logWatch(root, new Date(), { kind: 'error', error: errMsg(e) });
        } finally {
          // In a finally: rescheduling only on success is how one bad tick ends the session.
          // watchIntervalMs() throws when unconfigured, so it stays guarded.
          const every = watchTiming() === null ? null : watchIntervalMs();
          if (!stopped && every !== null) schedule(every);
        }
      }, delay);
    };
    schedule(0); // arming should tell you something now, not in fifteen minutes
    // Runs on disarm AND on unmount, so quitting the app releases the machine too. The `-w` in
    // caffeinateArgs is the backstop for the ways a process ends without reaching this at all.
    return () => {
      stopped = true;
      clearTimeout(timer);
      awake?.kill();
      investigationRef.current?.kill();
      investigationRef.current = null;
      setKeepingAwake(false);
      // Guarded like the armed log above it: with the window unconfigured the loop never
      // screened, so logging that it disarmed writes a session that did not happen.
      if (watchTiming() !== null)
        void logWatch(root, new Date(), { kind: 'disarmed' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchOn]);

  return {
    on: watchOn,
    toggle: () => setWatchOn((v) => !v),
    busy: watchBusy,
    at: watchAt,
    keepingAwake,
    note: watchNote,
    who: watchWho,
    invokedAt,
    invokedCount,
    notifiedAt,
    verdictHead,
    verdictClipped,
    verdictOf: watchVerdictOf,
  };
}
