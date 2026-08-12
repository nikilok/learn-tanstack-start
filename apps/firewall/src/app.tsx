// The interactive rule-manager TUI: a stateful Ink container wiring the data layer
// (client.ts, report-data.ts) to the presentational components in ./components.

import { fileURLToPath } from 'node:url';

import {
  type DOMElement,
  Box,
  Text,
  measureElement,
  useApp,
  useInput,
} from 'ink';
import { useEffect, useRef, useState } from 'react';

import { actionColor, actionOptions, cycleAction, isLogOnly } from './actions';
import { type Advice, adviseBan } from './ban-advice';
import {
  type ApplyStatus,
  type Item,
  applyItem,
  fetchLive,
  projectId,
  seedItems,
  teamId,
  token,
} from './client';
import { copyToClipboard } from './clipboard';
import { Lines } from './components/lines';
import { ReportView } from './components/report-view';
import { type Phase, Row, summaryLine } from './components/rule-list';
import {
  ASN_DENY,
  JA4_DENY,
  enforcedNow,
  pendingEdits,
  valuesOf,
  withValue,
  withoutValue,
} from './deny-list';
import { type Activity, fetchDenyActivity } from './denylist-data';
import { type DenyEntry, denylistLines } from './denylist-view';
import { persistEnvVar } from './env-file';
import {
  QUIET_FLOOR,
  busiestCount,
  columnWidth,
  noAlpn,
  pickable,
  pickerLayout,
  quietBand,
} from './identity-list';
import { moveCursor, resolveIpEntry } from './ip-entry';
import { type IpProfile, type Subject, topIps, topJa4 } from './ip-profile';
import { profileLines } from './ip-profile-view';
import { type ReportData, fetchReport } from './report-data';
import { trustedRules } from './rule-integrity';
import { dryRun, rules } from './rules';
import { type SitemapReport, fetchSitemapReport } from './sitemap-readers';
import { sitemapLines } from './sitemap-view';
import {
  LIVE_MINUTES,
  type Window,
  WINDOW_PRESETS,
  resolveWindow,
  rollingMinutes,
  rollingWindow,
} from './time-window';
import {
  watchHours,
  watchIntervalMs,
  watchTiming,
  allowedBotsOrUnknown,
} from './tuning';
import { type IpTab, tabWindow, useIpTabs } from './use-ip-tabs';
import { type Pane, usePane } from './use-pane';
import { errMsg } from './util';
import {
  adviceSummary,
  adviceWhy,
  logShadow,
  screenOnce,
  watchlistAdditions,
} from './watch';
import { WATCH_LOG, clockTime, logWatch } from './watch-log';
import {
  fingerprintConfig,
  investigationChangedConfig,
  caffeinateArgs,
  canKeepAwake,
  recentSpawns,
  runInvestigation,
  shouldInvestigate,
  verdictFrom,
} from './watch-mode';
import {
  readInvestigated,
  writeInvestigated,
  concludedKey,
  concludedText,
  notify,
  rememberNotified,
  shouldNotify,
} from './watch-notify';
import {
  IGNORELIST_FILE,
  WATCHLIST_FILE,
  type WatchlistEntry,
  readList,
  recordAdditions,
  recordExclusive,
  removeEntry,
  saveList,
} from './watchlist';
import { ignoreListLines, watchlistLines } from './watchlist-view';

type PaneKind =
  | 'report'
  | 'ip'
  | 'sitemap'
  | 'denylist'
  | 'watchlist'
  | 'ignorelist';
const PANE_KEY: Record<string, PaneKind> = {
  r: 'report',
  i: 'ip',
  f: 'ip', // same pane, fingerprint picker
  s: 'sitemap',
  d: 'denylist',
  t: 'watchlist',
  g: 'ignorelist',
};
const JA4_RULE = 'deny-scraper-ja4';
const ASN_RULE = 'deny-scraper-asn';
const DENY_ACTIVITY_HOURS = 144;
// Repo root, the single source of truth the denylist rules are rebuilt from on every apply.
const ENV_PATH = fileURLToPath(new URL('../../../.env.local', import.meta.url));
// Where the watch list and the watch log live — the CLI runs from here too, so they share state.
const ROOT = process.cwd();
const IP_WINDOW_HOURS = 24;
// One query per tick. Measured: 10 back-to-back calls to this endpoint all returned 200 at ~1s
// each, so ~1/s is tolerated. This sits 15x under that, matching the cadence Vercel's own live
// view uses, and backs off on failure rather than relying on never finding the real ceiling.
// Cost when left running: 4 queries/min, ~5.8k/day — about what 290 profile loads cost.
const LIVE_REFRESH_MS = 15_000;
// Consecutive failures double the interval, up to this. A watcher left running for days must
// never turn into a retry storm against an endpoint that has started refusing it.
const LIVE_BACKOFF_MAX_MS = 15 * 60_000;
// A profile is ~21 queries against the list's 1, so the tab on screen refreshes every Nth tick,
// and only that one. That is ~46 queries/min all in, under the ~60/min the endpoint was measured
// to sustain. Refreshing four background tabs every tick would be ~340/min and would rate-limit
// the tool against itself.
const LIVE_TAB_EVERY = 2;
// The API is asked for 500 groups whatever we pass, so keeping fewer only discards rows already
// paid for. Everything below the top few is what the quiet band is drawn from.
/**
 * The profile, plus a note if the allowlist could not be read.
 *
 * Non-mutating: the profile is rendered state. An unreadable allowlist exempts EVERY verified
 * crawler, which is a large silent change in what this pane recommends — inferring it from
 * "everything is suddenly legitimate" is not something an operator should have to do.
 */
function withAllowlistError(p: IpProfile): IpProfile {
  const { error } = allowedBotsOrUnknown();
  return error
    ? { ...p, errors: [...p.errors, `FW_ALLOWED_BOTS: ${error}`] }
    : p;
}

const TOP_IPS_LIMIT = 500;
const MIN_BUSIEST = 10; // busiest rows always shown
// Grows past the minimum while the leaders are still competing. Bounded because the picker eats
// into the pane it sits under, and because every extra row is one more identity to read.
const MAX_BUSIEST = 20;
const QUIET_ROWS = 10; // quiet-band rows shown beside them
// `o` opens each listed subject at ~21 observability queries, against an endpoint measured to
// sustain ~60/min. It stays fixed while the list above it grows, or one keypress rate-limits the
// tool against itself.
const OPEN_ALL_MAX = 8;
const VERDICT_LINES = 12; // rendered inline; the rest stays in the log
const PANE_SHARE = 0.7; // the pane holds the data; the rules list is names and a tag
// Enough for the deny rule names in full plus a pending marker. At 34 the two deny rules both
// truncated to "deny-sc…", which is worse than useless when one of them has a staged change.
const MIN_RULES_W = 46;
// Below this the data pane cannot say anything useful, so it is hidden rather than squeezed.
const MIN_PANE_W = 46;
const PANE_GAP = 2; // marginRight between the two columns
// Every part of a picker row, so the width test cannot drift from what is drawn. Derived rather
// than written as one number: the space after the count lives in the JSX and was missed once.
const CURSOR_W = 2; // '▶ ' / '  '
const COUNT_W = 7; // right-aligned request count
const ROW_W = CURSOR_W + COUNT_W + 1; // ... and the space before the identity
const FLAG_W = 3; // ' ⚑' — budgeted at 2 cells, since the glyph is ambiguous-width
const OPEN_W = 7; // ' (open)'
const CAP_BUSIEST = 'busiest';
const CAP_QUIET = `quietest over ${QUIET_FLOOR}`;
const ROW_CHROME = {
  row: ROW_W,
  cursor: CURSOR_W,
  flag: FLAG_W,
  open: OPEN_W,
};
const IP_CHARS = /^[0-9a-fA-F.:]+$/; // everything an IPv4/IPv6 literal can contain

/** Interactive firewall manager: toggle each rule on/off and switch its action (log/challenge/deny/bypass), view the report in a side pane, then apply (upsert) to Vercel. */
export function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [menuCursor, setMenuCursor] = useState(0);
  const [idByName, setIdByName] = useState<Map<string, string>>(new Map());
  // Undefined until the live config loads, and undefined is meaningful: the advisory treats
  // "not read" differently from "no rule qualifies".
  const [trustedAllow, setTrustedAllow] = useState<string[] | undefined>(
    undefined,
  );
  const [error, setError] = useState('');
  // Last apply's outcome; cleared by the next edit so it can't describe stale state.
  const [applied, setApplied] = useState<{
    summary: string;
    ok: boolean;
  } | null>(null);
  const report = usePane<ReportData>();
  const sitemap = usePane<SitemapReport>();
  const ipTabs = useIpTabs({ projectId, teamId, token });
  const [pane, setPane] = useState<PaneKind | null>(null);
  const [focus, setFocus] = useState<
    | 'editor'
    | 'pane'
    | 'ip-input'
    | 'asn-input'
    | 'range-input'
    | 'window-pick'
    | 'confirm'
  >('editor');
  // Which identity the picker and new tabs address. `i` and `f` set it.
  const [pickKind, setPickKind] = useState<'ip' | 'ja4'>('ip');
  const [ipInput, setIpInput] = useState('');
  const [ipError, setIpError] = useState('');
  // -1 means "use what I typed"; 0+ indexes the filtered suggestions, like a URL bar.
  const [ipCursor, setIpCursor] = useState(-1);
  const [asnInput, setAsnInput] = useState('');
  const [asnError, setAsnError] = useState('');
  // The window IP lookups use. Rolling by default; `w` switches it to a typed date range.
  // Index into WINDOW_PRESETS; -1 means a custom typed range is in force.
  const [presetIdx, setPresetIdx] = useState(() =>
    WINDOW_PRESETS.findIndex((p) => p.minutes === IP_WINDOW_HOURS * 60),
  );
  const [ipWindow, setIpWindow] = useState<Window>(() =>
    rollingWindow(IP_WINDOW_HOURS, new Date()),
  );
  const [windowCursor, setWindowCursor] = useState(0);
  // Where `w` was pressed, so choosing a timeline returns there. Picking a window while
  // choosing an IP is a step in choosing that IP, not a reason to leave the picker.
  const windowReturn = useRef<'pane' | 'ip-input'>('pane');
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const topIpList = usePane<[string, number][]>();
  const topJa4List = usePane<[string, number][]>();
  const denyActivity = usePane<Map<string, Activity>>();
  const [denyCursor, setDenyCursor] = useState(0);
  // An error that arrived WITH partial data. usePane.error only carries a total failure, so
  // without this a partial activity map renders as a complete one.
  const [denyActivityNote, setDenyActivityNote] = useState('');
  const [sitemapCursor, setSitemapCursor] = useState(0);
  const [copied, setCopied] = useState('');
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [watchlistError, setWatchlistError] = useState('');
  const [watchlistCursor, setWatchlistCursor] = useState(0);
  const [ignoreList, setIgnoreList] = useState<WatchlistEntry[]>([]);
  const [ignoreError, setIgnoreError] = useState('');
  const [ignoreCursor, setIgnoreCursor] = useState(0);
  // Unbanned this session: the value is gone from the rule, so it needs its own record to stay
  // on screen as a pending change until applied.
  const [removedDenies, setRemovedDenies] = useState<string[]>([]);
  const [stagedDenies, setStagedDenies] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{
    prompt: string;
    detail: string;
    onYes: () => void;
  } | null>(null);
  // Read by the live-refresh interval, which must not capture a stale render's values.
  const pickKindRef = useRef(pickKind);
  pickKindRef.current = pickKind;
  const topIpListRef = useRef(topIpList);
  topIpListRef.current = topIpList;
  const topJa4ListRef = useRef(topJa4List);
  topJa4ListRef.current = topJa4List;
  const failuresRef = useRef(0); // consecutive live-refresh failures, drives the backoff
  const tickRef = useRef(0);
  const activeTabRef = useRef(ipTabs.active);
  activeTabRef.current = ipTabs.active;
  const refreshTabRef = useRef(ipTabs.refresh);
  refreshTabRef.current = ipTabs.refresh;
  const applying = useRef(false); // re-entrancy guard: 'a' fires before the phase re-render lands
  // Quit requested mid-apply: exit() only unmounts, so the loop must stop itself first.
  const cancelApply = useRef(false);
  const [reportScroll, setReportScroll] = useState(0);
  const [reportMaxScroll, setReportMaxScroll] = useState(0);
  const reportRef = useRef<DOMElement | null>(null);

  // Watch mode. Runs off the app's own timer whatever pane is open, since the point is to be
  // left running. State lives in refs where the loop reads it: the effect is armed once and its
  // closure would otherwise keep whatever the values were at arming.
  const [watchOn, setWatchOn] = useState(false);
  const [watchNote, setWatchNote] = useState('');
  // Who the last tick actually profiled, one line each — the note above only counts them.
  const [watchWho, setWatchWho] = useState<string[]>([]);
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

  const isLive = ipWindow.label === 'live';
  const [blink, setBlink] = useState(true);
  const paneLoading =
    pane === 'report'
      ? report.loading
      : pane === 'sitemap'
        ? sitemap.loading
        : pane === 'ip'
          ? Boolean(ipTabs.active?.loading)
          : false;

  // Bound the report pane to the terminal height so the rendered frame never exceeds the viewport —
  // otherwise a tall report makes the terminal itself scroll and the editor cursor disappears above it.
  const rows = process.stdout.rows ?? 24;
  const reportH = Math.max(8, rows - 1);

  useEffect(() => {
    fetchLive()
      .then((live) => {
        setIdByName(live.idByName);
        setTrustedAllow(trustedRules(live.headerKeysByName, rules));
        setItems(seedItems(live));
        setPhase('select');
      })
      .catch((e: unknown) => {
        setError(errMsg(e));
        setPhase('fatal');
        process.exitCode = 1;
      });
  }, []);

  // Measure the pane content (post-render) to clamp how far it can scroll: content height minus
  // the visible area (reportH minus the box's top+bottom border).
  useEffect(() => {
    if (!pane || !reportRef.current) return;
    const max = Math.max(
      0,
      measureElement(reportRef.current).height - (reportH - 2),
    );
    setReportMaxScroll(max);
    setReportScroll((s) => Math.min(s, max));
  }, [
    pane,
    report.data,
    sitemap.data,
    ipTabs.active?.data,
    ipTabs.index,
    reportH,
  ]);

  // A blinking marker, so a watch screen left on a desk reads as live at a glance rather than
  // looking like a frozen snapshot.
  useEffect(() => {
    if (!isLive || pane !== 'ip') return;
    const id = setInterval(() => setBlink((b) => !b), 800);
    return () => clearInterval(id);
  }, [isLive, pane]);

  // Switching tabs while live must start updating the newly-visible one immediately, rather
  // than leaving it on its old snapshot until the next qualifying tick.
  useEffect(() => {
    if (!isLive || pane !== 'ip' || !ipTabs.active) return;
    refreshTabRef.current(ipWindow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, pane, ipTabs.index]);

  // The live window re-queries itself, so the tool can be left open as a watch screen. The list
  // every tick; the tab you are looking at every LIVE_TAB_EVERY ticks. Background tabs are left
  // frozen deliberately — they show their snapshot age instead, so stale data never reads current.
  useEffect(() => {
    if (!isLive || pane !== 'ip') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // setTimeout, not setInterval: a tick that takes longer than the period must not queue
    // another behind it, and the delay has to change when we back off.
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        const w = rollingMinutes(LIVE_MINUTES, new Date(), 'live');
        setIpWindow(w);
        const cache =
          pickKindRef.current === 'ip'
            ? topIpListRef.current
            : topJa4ListRef.current;
        cache.reset();
        // The outcome comes from load itself: it catches every rejection, so a flag set inside
        // the fetcher cannot see a request the pane dropped as a duplicate, and that reset the
        // backoff to zero on the exact ticks it was supposed to be lengthening.
        const outcome = await cache.load(async () => {
          const { rows, error } =
            pickKindRef.current === 'ip'
              ? await topIps(creds, w, TOP_IPS_LIMIT)
              : await topJa4(creds, w, TOP_IPS_LIMIT);
          if (error) throw new Error(error);
          return rows;
        });
        if (stopped) return;
        // Only the visible tab, and only every Nth tick — a profile costs ~21 queries.
        tickRef.current += 1;
        if (tickRef.current % LIVE_TAB_EVERY === 0) {
          const active = activeTabRef.current;
          // `w`, not the tab's stored window: live advances every tick, and re-querying the
          // period the tab was opened in would render stale traffic under a "live" header.
          if (active) refreshTabRef.current(w);
        }
        // A skipped load neither succeeded nor failed, so it must not clear the backoff.
        if (outcome === 'ok') failuresRef.current = 0;
        else if (outcome === 'error') failuresRef.current += 1;
        schedule(
          Math.min(
            LIVE_REFRESH_MS * 2 ** failuresRef.current,
            LIVE_BACKOFF_MAX_MS,
          ),
        );
      }, delay);
    };
    schedule(LIVE_REFRESH_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, pane]);

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
    if (canKeepAwake(process.platform)) {
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
      await flushPending();
      setWatchBusy(true);
      try {
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
          else if (listed.entries) {
            setWatchlist(listed.entries);
            setWatchlistError('');
          }
        }
        setWatchWho(
          findings.map(
            (f) => `${f.digest} · ${f.total} req · ${adviceSummary(f.advice)}`,
          ),
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
            const failed = await notify(alarms.join(' · '));
            if (failed) setWatchNote(failed);
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
        spawnsRef.current = [...spawnsRef.current, now];
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
        const envPath = `${root}/.env.local`;
        const beforeCfg = await fingerprintConfig(envPath);
        let child: { kill: () => void } | null = null;
        const out = await runInvestigation(
          next,
          process.cwd(),
          watchHours(),
          (c) => {
            child = c;
            // A child arriving after disarm has nobody left to stop it.
            if (stopped) c.kill();
            else investigationRef.current = c;
          },
        );
        // Only if it still points at OUR child. A disarm-and-rearm during the await leaves this
        // continuation running while the new effect has already stored its own handle, and
        // clearing unconditionally strands that child with nothing able to kill it.
        if (investigationRef.current === child) investigationRef.current = null;
        if (
          investigationChangedConfig(
            beforeCfg,
            await fingerprintConfig(envPath),
          )
        ) {
          const alarm = `.env.local CHANGED during the investigation of ${next.digest} — the run was told not to apply anything.`;
          setWatchNote(alarm);
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
        if (!stopped) setWatchBusy(false);
      }
    };

    // setTimeout, not setInterval: a tick that outruns the period must not queue another behind
    // it — a screen plus an investigation can take minutes.
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await tick();
        // Guarded like the tick above: watchIntervalMs() throws when unconfigured, and an
        // unhandled throw HERE kills the loop one tick after the guard said it was fine.
        const every = watchTiming() === null ? null : watchIntervalMs();
        if (!stopped && every !== null) schedule(every);
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
      void logWatch(root, new Date(), { kind: 'disarmed' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchOn]);

  /** Sequentially upsert each rule with its chosen active + action, updating per-row status; refreshes ids first so a dashboard edit since load can't target a stale id; sets a non-zero exit code on any failure. */
  const applyAll = async (snapshot: Item[]) => {
    let ids = idByName;
    try {
      ids = (await fetchLive()).idByName;
    } catch {
      // keep the mount snapshot if the refresh fails — better than aborting the apply.
    }
    let anyError = false;
    let cancelled = false;
    const statuses: ApplyStatus[] = [];
    // Per rule, not just a global flag: a deny that reached the WAF must be written back to
    // .env.local even if an unrelated rule later fails, or the next apply silently lifts it.
    const outcome = new Map<string, ApplyStatus>();
    for (let i = 0; i < snapshot.length; i++) {
      // Checked between rules, never mid-request, so a quit can't leave one rule half-written.
      if (cancelApply.current) {
        cancelled = true;
        break;
      }
      setItems((prev) =>
        prev.map((it, j) => (j === i ? { ...it, status: 'applying' } : it)),
      );
      try {
        const res = await applyItem(snapshot[i], ids);
        if (res.status === 'error') anyError = true; // a returned (not thrown) error must still fail the run
        statuses.push(res.status);
        outcome.set(snapshot[i].rule.name, res.status);
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: res.status, detail: res.detail } : it,
          ),
        );
      } catch (e) {
        anyError = true;
        statuses.push('error');
        outcome.set(snapshot[i].rule.name, 'error');
        const detail = errMsg(e);
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: 'error', detail } : it,
          ),
        );
      }
    }
    // Set both ways: a retry that succeeds after a failed apply must not still exit non-zero.
    applying.current = false;
    if (cancelled) {
      // Persist first: quitting mid-apply after the deny rule was written would otherwise
      // strand a live ban that the next session lifts.
      const cancelledPersist = persistDenies(outcome, snapshot);
      // The TUI is about to tear down, so the shell's exit code is the only channel left. A
      // deny live in the WAF but missing from .env.local must not look like a clean quit.
      process.exitCode = anyError || !cancelledPersist.ok ? 1 : 0;
      if (!cancelledPersist.ok)
        console.error(`firewall:setup${cancelledPersist.summary}`);
      exit(); // deferred to here so no write is still in flight
      return;
    }
    // The rules are rebuilt from env on every apply, so a digest that lives only in the WAF is
    // un-banned by the next CI run. Write back whatever ACTUALLY landed — keyed off each deny
    // rule's own outcome, because an unrelated rule failing must not strand a live ban.
    const persisted = persistDenies(outcome, snapshot);
    // Set both ways: a retry that succeeds after a failed apply must not still exit non-zero.
    process.exitCode = anyError || !persisted.ok ? 1 : 0;
    // Back to the editor, not a terminal screen — an apply is a step in a session.
    setApplied({
      summary: summaryLine(statuses) + persisted.summary,
      ok: !anyError && persisted.ok,
    });
    setPhase('select');
  };

  const creds = { projectId, teamId, token };

  /** Write each deny rule that actually reached the WAF back to .env.local. Returns whether every pending edit was persisted plus a summary suffix — `ok` is load-bearing: a deny live in the WAF but absent from .env.local is lifted by the next apply, so it must fail the run rather than only warn. */
  const persistDenies = (
    outcome: Map<string, ApplyStatus>,
    snapshot: Item[],
  ): { ok: boolean; summary: string } => {
    if (!stagedDenies.length && !removedDenies.length)
      return { ok: true, summary: '' };
    // A dry run reaches no WAF, so writing the denylist back would enforce or lift a ban the
    // operator only previewed — .env.local is what the next real apply and CI rebuild from.
    if (dryRun)
      return { ok: true, summary: ' · dry-run: .env.local NOT written' };
    const notes: string[] = [];
    let wrote = false;
    // A cancelled run breaks out of applyAll part-way, so `outcome` can hold one deny rule and
    // not the other. Clearing the staged lists on the strength of the one that landed would
    // drop the other's values unpersisted, and the next apply rebuilds from env and lifts them.
    let unreached = false;
    for (const [ruleName, spec, envKey] of [
      [JA4_RULE, JA4_DENY, 'FW_BLOCKED_JA4'],
      [ASN_RULE, ASN_DENY, 'FW_BLOCKED_ASN'],
    ] as const) {
      const item = snapshot.find((it) => it.rule.name === ruleName);
      const status = outcome.get(ruleName);
      if (!item) continue;
      if (!status) {
        unreached = true;
        continue;
      }
      if (status === 'error') {
        notes.push(`${envKey} NOT saved — ${ruleName} failed to apply`);
        continue;
      }
      try {
        persistEnvVar(ENV_PATH, envKey, valuesOf(item.rule, spec).join(','));
        wrote = true;
      } catch (e) {
        notes.push(
          `${envKey} NOT saved (${errMsg(e)}) — the next apply will undo it`,
        );
      }
    }
    if (wrote && !notes.length && !unreached) {
      setStagedDenies([]);
      setRemovedDenies([]);
      return { ok: true, summary: ' · denylist saved to .env.local' };
    }
    if (unreached)
      notes.push(
        'a deny rule was never reached, so its staged edits are still unapplied',
      );
    return {
      ok: !notes.length,
      summary: notes.length ? ` · WARNING: ${notes.join('; ')}` : '',
    };
  };

  const denyRuleOf = (name: string) =>
    items.find((it) => it.rule.name === name);
  // A rule can sit in the WAF with active:false, or cycled to log/challenge — both states leave
  // the traffic served normally. Reporting ALREADY DENIED for either tells the operator a
  // scraper is handled while it is not, which is the most costly kind of wrong. seedItems
  // prefers the LIVE action, so a stray ←/→ that once reached the WAF persists across applies.
  const enforcing = (it: Item | undefined) =>
    Boolean(it?.active && it.action === 'deny');
  const ja4Item = denyRuleOf(JA4_RULE);
  const ja4Enforcing = enforcing(ja4Item);
  const liveJa4 =
    ja4Item && ja4Enforcing ? valuesOf(ja4Item.rule, JA4_DENY) : [];
  const asnItem = denyRuleOf(ASN_RULE);
  const liveAsn =
    asnItem && enforcing(asnItem) ? valuesOf(asnItem.rule, ASN_DENY) : [];
  // Only worth saying for a rule that actually carries denies — a revoked one denying nothing is
  // the intended resting state, not a fault.
  const denyNotEnforcing = (
    [
      [ja4Item, JA4_DENY],
      [asnItem, ASN_DENY],
    ] as const
  )
    .filter(
      ([it, spec]) =>
        it && !enforcing(it) && valuesOf(it.rule, spec).length > 0,
    )
    .map(([it]) => ({
      rule: it!.rule.name,
      why: !it!.active
        ? 'the rule is DEACTIVATED'
        : `its action is ${it!.action}, not deny — matching traffic is still served`,
    }));
  const act = denyActivity.data;
  const stagedNormalized = (spec: typeof JA4_DENY) =>
    new Set(stagedDenies.map((v) => spec.normalize(v.trim())));
  const denyEntries: DenyEntry[] = [
    ...liveJa4.map((v) => ({
      kind: 'ja4' as const,
      value: v,
      // Normalized both sides: the rule stores the digest normalized while stageDeny keeps what
      // was typed, so a raw `includes` rendered a staged deny as `live` and hid the
      // "press a to apply" banner.
      staged: stagedNormalized(JA4_DENY).has(JA4_DENY.normalize(v)),
      removed: false,
      requests: act?.get(v)?.requests,
      denied: act?.get(v)?.denied,
    })),
    ...liveAsn.map((v) => ({
      kind: 'asn' as const,
      value: v,
      staged: stagedNormalized(ASN_DENY).has(ASN_DENY.normalize(v)),
      removed: false,
      requests: act?.get(v)?.requests,
      denied: act?.get(v)?.denied,
    })),
    ...removedDenies.map((v) => ({
      // By shape, not by a substring guess: the two denylists share one flat removal list.
      kind: (JA4_DENY.valid(v) ? 'ja4' : 'asn') as 'ja4' | 'asn',
      value: v,
      staged: false,
      removed: true,
      requests: act?.get(v)?.requests,
      denied: act?.get(v)?.denied,
    })),
  ];
  const subjectDigest = ipTabs.active?.data
    ? ipTabs.active.data.subject.kind === 'ja4'
      ? ipTabs.active.data.subject.value
      : (ipTabs.active.data.byJa4[0]?.[0] ?? '')
    : '';
  // Rules carrying unapplied denylist edits, so the list can say so rather than looking inert.
  const pendingByRule = new Map<string, string>();
  for (const [ruleName, spec] of [
    [JA4_RULE, JA4_DENY],
    [ASN_RULE, ASN_DENY],
  ] as const) {
    const item = denyRuleOf(ruleName);
    if (!item) continue;
    const { added, dropped } = pendingEdits(
      valuesOf(item.rule, spec),
      stagedDenies,
      removedDenies,
      spec,
    );
    // Kept terse so it survives a narrow rules column; the footer and denylist pane carry detail.
    const parts = [
      added ? `+${added}` : '',
      dropped ? `−${dropped}` : '',
    ].filter(Boolean);
    if (parts.length) pendingByRule.set(ruleName, parts.join(' '));
  }

  // Read once. The error is carried into the pane rather than swallowed: an unreadable
  // allowlist exempts EVERY verified crawler, which is a large silent change in what this pane
  // will recommend, and inferring it from "everything is suddenly legitimate" is not reasonable.
  const allowlist = allowedBotsOrUnknown();
  const ipAdvice = ipTabs.active?.data
    ? adviseBan({
        total: ipTabs.active.data.total,
        mix: ipTabs.active.data.mix,
        shape: ipTabs.active.data.shape,
        ja4: ipTabs.active.data.byJa4,
        asns: ipTabs.active.data.byAsn,
        botVerified: ipTabs.active.data.byBotVerified,
        // Both, or this pane exempts every verified crawler while the watch and the CLI do
        // not — the fourth time these two paths have disagreed about a gate.
        verifiedBots: ipTabs.active.data.verifiedBots,
        allowedBots: allowlist.names,
        wafActions: ipTabs.active.data.byWafAction,
        wafRules: ipTabs.active.data.byWafRule,
        statuses: ipTabs.active.data.byStatus,
        digestReach: ipTabs.active.data.digestReach,
        asnReach: ipTabs.active.data.asnReach,
        // Live-and-applied, NOT merely present in the rule: a staged digest is in the local
        // rule but has not been written, and calling that "already denied" is a lie.
        alreadyDeniedJa4: enforcedNow(
          liveJa4,
          stagedDenies,
          removedDenies,
          subjectDigest,
          JA4_DENY,
        ),
        stagedJa4: stagedDenies.includes(subjectDigest),
        // AS numbers cannot be derived from the name observability reports, so an ASN already
        // in FW_BLOCKED_ASN is caught at staging (the number is typed there), not here.
        alreadyDeniedAsn: false,
        windowMinutes: ipTabs.active.data.windowHours * 60,
        // Absent evidence is not evidence of absence: a query that failed must read as unjudged,
        // never as a clean client.
        failedQueries: ipTabs.active.data.failedQueries,
        trustedAllowRules: trustedAllow,
        rpcsPartial: ipTabs.active.data.rpcsPartial,
        mixPartial: ipTabs.active.data.mixPartial,
      })
    : undefined;

  // Substring, not prefix: an IP is often recognised by its tail as much as its network part.
  const pickList = pickKind === 'ip' ? topIpList : topJa4List;
  const ipFiltered = (pickList.data ?? []).filter(
    ([ip]) => !ipInput || ip.includes(ipInput),
  );
  // How many count as busy is a property of the traffic, not a constant: a fixed cut hides the
  // ninth of nine competing leaders. Bounded by the viewport too, since these rows are taken from
  // the pane below and reportH can be as little as 8.
  const busiest = busiestCount(
    ipFiltered,
    MIN_BUSIEST,
    Math.min(MAX_BUSIEST, Math.max(MIN_BUSIEST, reportH - QUIET_ROWS)),
  );
  const ipMatches = ipFiltered.slice(0, busiest);
  // Only when browsing. Under a filter the list is already the answer to a question, and a
  // second column drawn from the same matches would just repeat its tail.
  // Skips exactly what the busiest column drew, so the two can never overlap as it grows.
  const quietMatches = ipInput
    ? []
    : quietBand(ipFiltered, ipMatches.length, QUIET_ROWS);
  // One flat list, so the cursor, Enter and what is on screen cannot disagree.
  const ipPickable = pickable(ipMatches, quietMatches);

  // Shared with the width measurement above, so a row can never be drawn wider than it was
  // measured — which is what wraps a row and costs the pane an unreserved line.
  const isOpen = (id: string) =>
    ipTabs.tabs.some((t) => t.subject.value === id);
  /** Free, and independent of volume. Not a verdict — a verified crawler inverts the same tell. */
  const isFlagged = (id: string) => pickKind === 'ja4' && noAlpn(id);

  /** One picker row. `i` indexes ipPickable, so the cursor means the same thing in both columns. */
  const pickerRow = ([id, count]: [string, number], i: number) => {
    const open = isOpen(id);
    const tell = isFlagged(id);
    return (
      <Box key={id}>
        <Text color="cyan">{i === ipCursor ? '▶ ' : '  '}</Text>
        <Text dimColor>{String(count).padStart(COUNT_W)} </Text>
        <Text
          bold={i === ipCursor}
          color={i === ipCursor ? 'cyan' : tell ? 'yellow' : undefined}
        >
          {id}
        </Text>
        {tell && <Text color="yellow"> ⚑</Text>}
        {open && <Text dimColor> (open)</Text>}
      </Box>
    );
  };

  /** Open a pane, loading it on first view. `i` always prompts for another IP — tab is how you get back to one already open. */
  const openPane = (kind: PaneKind, pick: 'ip' | 'ja4' = 'ip') => {
    setPane(kind);
    setReportScroll(0);
    // The copy note describes an action on the pane being left; carried across, it reads as a
    // response to whatever key opened this one.
    setCopied('');
    if (kind === 'ip') {
      setPickKind(pick);
      setIpInput('');
      setIpError('');
      setIpCursor(-1);
      setFocus('ip-input');
      // Picking from live traffic beats typing an address from memory. Fetched once per session.
      void loadPickList(pick, ipWindow);
      return;
    }
    setFocus('pane');
    if (kind === 'report' && !report.data)
      void report.load(() => fetchReport(creds));
    // Always re-read: the file is local, and the watch tick or a CLI run may have fed it since.
    if (kind === 'watchlist') void loadWatchlist();
    if (kind === 'ignorelist') void loadIgnoreList();
    if (kind === 'sitemap' && !sitemap.data)
      void sitemap.load(() => fetchSitemapReport(creds, ipWindow));
    if (kind === 'denylist' && !denyActivity.data)
      void denyActivity.load(async () => {
        const { activity, error } = await fetchDenyActivity(
          creds,
          DENY_ACTIVITY_HOURS,
          liveJa4,
        );
        if (error && !activity.size) throw new Error(error);
        // Partial is not complete: a nonempty map with an error behind it must still say so, or
        // a digest missing from it reads as "no traffic — safe to retire".
        setDenyActivityNote(error ?? '');
        return activity;
      });
  };

  /** Tab from elsewhere surfaces the IP tabs at the one you were last on; only a second press moves. Advancing straight away would skip a tab you had not seen yet. */
  const gotoIpTabs = (dir: 1 | -1) => {
    setReportScroll(0);
    setFocus('pane');
    if (pane === 'ip') ipTabs.cycle(dir);
    else setPane('ip');
  };

  /** Stage a value into its deny rule. Nothing reaches the WAF until the apply. */
  const stageDeny = (kind: 'ja4' | 'asn', value: string) => {
    const ruleName = kind === 'ja4' ? JA4_RULE : ASN_RULE;
    const spec = kind === 'ja4' ? JA4_DENY : ASN_DENY;
    // Validated here, not inside the updater: a throw in a setItems callback escapes the keypress
    // handler with no error boundary and every deny staged this session dies with the process.
    if (!spec.valid(spec.normalize(value.trim()))) {
      setAsnError(`refused — not ${spec.example}`);
      return;
    }
    setItems((prev) =>
      prev.map((it) =>
        it.rule.name === ruleName
          ? {
              ...it,
              rule: withValue(it.rule, spec, value).rule,
              status: 'idle',
              detail: undefined,
            }
          : it,
      ),
    );
    setStagedDenies((s) => [...new Set([...s, value])]);
    setRemovedDenies((s) => s.filter((v) => v !== value));
    setApplied(null);
  };

  /** Lift a deny. Same staging discipline: visible as pending until applied. */
  const unstageDeny = (entry: DenyEntry) => {
    const ruleName = entry.kind === 'ja4' ? JA4_RULE : ASN_RULE;
    const spec = entry.kind === 'ja4' ? JA4_DENY : ASN_DENY;
    setItems((prev) =>
      prev.map((it) =>
        it.rule.name === ruleName
          ? {
              ...it,
              rule: withoutValue(it.rule, spec, entry.value).rule,
              status: 'idle',
              detail: undefined,
            }
          : it,
      ),
    );
    setStagedDenies((s) => s.filter((v) => v !== entry.value));
    // Only a value that actually reached the WAF can be unbanned. Undoing a staged addition is
    // just dropping the stage; recording it as a removal invents an unban of something that was
    // never denied, and pendingEdits then counts it against the rule.
    if (!entry.staged)
      setRemovedDenies((s) => [...new Set([...s, entry.value])]);
    setApplied(null);
  };

  /** Load the picker list for `kind`. Cached per kind so switching back is instant. `force` is required after a window change: reset() is an async state update, so the cache check would still see the old window's rows and skip the fetch. */
  const loadPickList = (kind: 'ip' | 'ja4', w: Window, force = false) => {
    const cache = kind === 'ip' ? topIpList : topJa4List;
    if (cache.data && !force) return;
    void cache.load(async () => {
      const { rows, error } =
        kind === 'ip'
          ? await topIps(creds, w, TOP_IPS_LIMIT)
          : await topJa4(creds, w, TOP_IPS_LIMIT);
      if (error) throw new Error(error);
      return rows;
    });
  };

  /** Switch the window: refetch the picker list and re-profile the tab on screen, so flipping timelines is one key. */
  const applyWindow = (w: Window) => {
    setIpWindow(w);
    setRangeError('');
    topIpList.reset();
    topJa4List.reset();
    loadPickList(pickKind, w, true);
    // The sitemap pane is window-scoped too; without this it stayed frozen on whatever window
    // it was first opened with, whatever the header said.
    sitemap.reset();
    setSitemapCursor(0);
    if (pane === 'sitemap')
      void sitemap.load(() => fetchSitemapReport(creds, w));
    // Re-profile what is on screen at the new window — that IS the point of switching.
    if (ipTabs.active) ipTabs.open(ipTabs.active.subject, w, true);
  };

  /** Open the timeline list, starting on whatever is in force. */
  const openWindowPick = () => {
    setWindowCursor(presetIdx >= 0 ? presetIdx : WINDOW_PRESETS.length);
    windowReturn.current = focus === 'ip-input' ? 'ip-input' : 'pane';
    setFocus('window-pick');
  };

  /** Apply the highlighted timeline. The row past the presets is the custom date range. */
  const chooseWindow = () => {
    if (windowCursor >= WINDOW_PRESETS.length) {
      setRangeInput('');
      setRangeError('');
      setFocus('range-input');
      return;
    }
    const p = WINDOW_PRESETS[windowCursor];
    setPresetIdx(windowCursor);
    applyWindow(rollingMinutes(p.minutes, new Date(), p.label));
    setFocus(windowReturn.current);
  };

  /** Apply a typed date range to IP lookups. Blank reverts to the rolling default. */
  const submitRange = (raw: string) => {
    const text = raw.trim();
    const next = text
      ? resolveWindow(text, new Date())
      : { window: rollingWindow(IP_WINDOW_HOURS, new Date()) };
    if ('error' in next) {
      setRangeError(next.error);
      return;
    }
    // Blank reverts to the rolling default, which IS a preset — marking it custom left the
    // timeline list showing "custom… · in force" over a preset window.
    setPresetIdx(
      text
        ? -1
        : WINDOW_PRESETS.findIndex((p) => p.minutes === IP_WINDOW_HOURS * 60),
    );
    applyWindow(next.window);
    // Back to whoever opened the picker, matching preset selection. Choosing a range from the
    // report or sitemap pane used to drop the operator into the IP picker instead.
    if (windowReturn.current === 'ip-input') {
      setIpInput('');
      setIpCursor(-1);
    }
    setFocus(windowReturn.current);
  };

  /**
   * Open every match currently listed, so a shortlist can be compared by tabbing rather than
   * typed one at a time. Skips anything already open.
   *
   * Busiest column only. Each subject costs ~21 observability queries, so folding the quiet band
   * in would nearly triple what one keypress spends — and the quiet column is for spotting one
   * row worth a look, not for opening wholesale.
   */
  const submitAll = () => {
    const subjects = ipMatches.slice(0, OPEN_ALL_MAX).map(([value]) => ({
      kind: pickKind,
      value: pickKind === 'ja4' ? value.toLowerCase() : value,
    }));
    if (!subjects.length) return;
    setIpError('');
    setFocus('pane');
    setReportScroll(0);
    ipTabs.openMany(subjects, ipWindow);
  };

  /** Load the on-disk watch list into the pane, keeping unreadable distinct from empty. */
  const loadWatchlist = async () => {
    const list = await readList(ROOT, WATCHLIST_FILE);
    setWatchlist(list.entries);
    setWatchlistError(list.ok ? '' : (list.error ?? 'unreadable'));
    setWatchlistCursor((c) =>
      Math.max(0, Math.min(c, list.entries.length - 1)),
    );
  };

  /** Same for the ignore list. */
  const loadIgnoreList = async () => {
    const list = await readList(ROOT, IGNORELIST_FILE);
    setIgnoreList(list.entries);
    setIgnoreError(list.ok ? '' : (list.error ?? 'unreadable'));
    setIgnoreCursor((c) => Math.max(0, Math.min(c, list.entries.length - 1)));
  };

  /** Put an identity on one list and off the other — watched and ignored are exclusive. */
  const moveIdentity = async (
    to: 'watch' | 'ignore',
    subject: Subject,
    note: string,
  ) => {
    const [addFile, dropFile] =
      to === 'watch'
        ? [WATCHLIST_FILE, IGNORELIST_FILE]
        : [IGNORELIST_FILE, WATCHLIST_FILE];
    const out = await recordExclusive(
      ROOT,
      addFile,
      dropFile,
      [{ kind: subject.kind, id: subject.value, source: 'manual', note }],
      new Date(),
    );
    if (out.error) {
      setCopied(`${to} list: ${out.error}`);
      return;
    }
    const [added, remaining] = [out.added ?? [], out.remaining ?? []];
    if (to === 'watch') {
      setWatchlist(added);
      setIgnoreList(remaining);
    } else {
      setIgnoreList(added);
      setWatchlist(remaining);
    }
    setWatchlistError('');
    setIgnoreError('');
    const watchLen = (to === 'watch' ? added : remaining).length;
    const ignoreLen = (to === 'ignore' ? added : remaining).length;
    setWatchlistCursor((c) => Math.max(0, Math.min(c, watchLen - 1)));
    setIgnoreCursor((c) => Math.max(0, Math.min(c, ignoreLen - 1)));
    setCopied(
      to === 'watch'
        ? `watching ${subject.value} — t to view`
        : `ignoring ${subject.value} — g to view · watch mode now skips it`,
    );
  };

  /** Re-query whatever is on screen, so a pane is never stuck on a stale answer. */
  const refreshPane = () => {
    if (pane === 'report') void report.load(() => fetchReport(creds));
    else if (pane === 'watchlist') void loadWatchlist();
    else if (pane === 'ignorelist') void loadIgnoreList();
    else if (pane === 'sitemap')
      void sitemap.load(() => fetchSitemapReport(creds, ipWindow));
    else if (pane === 'ip') ipTabs.refresh();
    else if (pane === 'denylist')
      void denyActivity.load(async () => {
        const { activity, error } = await fetchDenyActivity(
          creds,
          DENY_ACTIVITY_HOURS,
          liveJa4,
        );
        if (error && !activity.size) throw new Error(error);
        setDenyActivityNote(error ?? '');
        return activity;
      });
  };

  /** Open `value` as a tab; keeps focus in the field when it is not an IP. Takes the value rather than reading state, so a paste that ends in a newline can submit what it just appended. */
  const submitIp = (value: string) => {
    const ip = value.trim();
    // Validated per kind: a JA4 contains letters and underscores an IP never can.
    const valid =
      pickKind === 'ip' ? IP_CHARS.test(ip) : JA4_DENY.valid(ip.toLowerCase());
    if (!ip || !valid) {
      setIpError(pickKind === 'ip' ? 'not an IP address' : 'not a JA4 digest');
      return;
    }
    setIpError('');
    setFocus('pane');
    setReportScroll(0);
    ipTabs.open(
      { kind: pickKind, value: pickKind === 'ja4' ? ip.toLowerCase() : ip },
      ipWindow,
    );
  };

  /** Edit the highlighted rule, clearing the apply state it invalidates so an edited-but-unapplied row is visibly distinct. */
  const editCursorItem = (change: (it: Item) => Item) => {
    setApplied(null);
    setItems((prev) =>
      prev.map((it, j) =>
        j === cursor
          ? { ...change(it), status: 'idle', detail: undefined }
          : it,
      ),
    );
  };

  /** Cycle the highlighted rule's action in the given direction. */
  const cycleCursorAction = (dir: 1 | -1) =>
    editCursorItem((it) => ({
      ...it,
      action: cycleAction(it.rule, it.action, dir),
    }));

  useInput((input, key) => {
    // A deny can take real users offline, so it never happens on one keystroke.
    if (focus === 'confirm') {
      if (input === 'y' || input === 'Y') {
        confirm?.onYes();
        setConfirm(null);
        setFocus('pane');
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirm(null);
        setFocus('pane');
      }
      return;
    }
    if (focus === 'window-pick') {
      if (key.escape) setFocus(windowReturn.current);
      else if (key.upArrow || input === 'k')
        setWindowCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === 'j')
        setWindowCursor((c) => Math.min(WINDOW_PRESETS.length, c + 1));
      else if (key.return) chooseWindow();
      return;
    }
    if (focus === 'range-input') {
      if (key.escape) setFocus(pane ? 'pane' : 'editor');
      else if (key.return) submitRange(rangeInput);
      else if (key.backspace || key.delete)
        setRangeInput((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        // Filter within the chunk and submit on an embedded newline: a pasted range arrives
        // whole, and testing the whole string would reject every paste.
        const next = (rangeInput + input.replace(/[^\d\s/.-]/g, '')).slice(
          0,
          32,
        );
        setRangeInput(next);
        if (/[\r\n]/.test(input)) submitRange(next);
      }
      return;
    }
    // Digits only: FW_BLOCKED_ASN takes a bare AS number.
    if (focus === 'asn-input') {
      if (key.escape) setFocus('pane');
      else if (key.return) {
        const num = asnInput.trim();
        const lever = ipAdvice?.lever;
        // The spec itself, not a copy of its regex: withValue throws inside a setItems updater,
        // which takes the whole TUI down and loses every deny staged this session.
        if (!ASN_DENY.valid(num)) {
          setAsnError(`AS number must be ${ASN_DENY.example}`);
          return;
        }
        setAsnError('');
        setConfirm({
          prompt: `Deny AS${num}? The evidence was measured on "${lever?.value ?? ''}"`,
          detail:
            'NOTHING can reconcile that number with that name — the API exposes no AS-number dimension, so check it yourself. Large operators announce many ASNs. An ASN deny hits EVERY client on the network you type.',
          onYes: () => stageDeny('asn', num),
        });
        setFocus('confirm');
      } else if (key.backspace || key.delete)
        setAsnInput((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta)
        setAsnInput((s) => (s + input.replace(/\D/g, '')).slice(0, 10));
      return;
    }
    // Text entry owns every keystroke, so q/j/k stay typeable inside an IP.
    if (focus === 'ip-input') {
      if (key.escape) setFocus(ipTabs.tabs.length ? 'pane' : 'editor');
      else if (key.return)
        submitIp(
          resolveIpEntry(
            ipInput,
            ipCursor,
            ipPickable.map(([ip]) => ip),
          ),
        );
      else if (key.upArrow)
        setIpCursor((c) => moveCursor(c, -1, ipPickable.length));
      else if (key.downArrow)
        setIpCursor((c) => moveCursor(c, 1, ipPickable.length));
      else if (key.backspace || key.delete) {
        setIpInput((s) => s.slice(0, -1));
        setIpCursor(-1);
      }
      // `w` cannot occur in an IP, so intercepting it here costs nothing and saves an esc.
      else if (input === 'w' || input === 'W') openWindowPick();
      // Same reasoning for `o`: no IP contains it (the filter strips non-hex anyway) and no JA4
      // digest does either, so filtering by it could only ever match nothing.
      else if (input === 'o' || input === 'O') submitAll();
      else if (input && !key.ctrl && !key.meta) {
        setIpCursor(-1); // typing re-asserts the typed text over any highlight
        // A paste arrives as ONE chunk, so filter within it rather than testing the whole
        // string — requiring the chunk to match meant pasting an IP silently did nothing.
        const allowed = pickKind === 'ip' ? /[^0-9a-fA-F.:]/g : /[^0-9a-z_]/gi;
        const next = (ipInput + input.replace(allowed, '')).slice(
          0,
          45, // longest IPv6 literal
        );
        setIpInput(next);
        if (/[\r\n]/.test(input)) submitIp(next); // pasted with a trailing newline
      }
      return;
    }
    if (focus === 'pane') {
      if (input === 'q') exit();
      // Tab cycles the open IPs from any pane, so comparing clients is one keystroke.
      else if (key.tab && ipTabs.tabs.length) gotoIpTabs(key.shift ? -1 : 1);
      else if (input === 'R') refreshPane();
      else if (input === 'v' || input === 'V') setWatchOn((on) => !on);
      else if (input === 'w' || input === 'W') openWindowPick();
      else if (input === 'b' && pane === 'ip' && ipAdvice?.lever) {
        // Only an OFFERED lever is stageable. A blocked client, or one whose every handle is
        // shared with something legitimate, has no lever and no keystroke gets past that.
        if (ipAdvice.blockers.length) return;
        const lever = ipAdvice.lever;
        if (lever.kind === 'asn') {
          // The AS number is not derivable from the name observability reports.
          setAsnInput('');
          setAsnError('');
          setFocus('asn-input');
          return;
        }
        setConfirm({
          prompt: `Deny TLS fingerprint ${lever.value}?`,
          detail: `${ipAdvice.reasons.length} tells agree · stages into FW_BLOCKED_JA4`,
          onYes: () => stageDeny('ja4', lever.value),
        });
        setFocus('confirm');
      } else if (pane === 'denylist' && key.return) {
        // Same reasoning as the sitemap pane: a JA4 is 37 characters that must be exact.
        const entry = denyEntries[denyCursor];
        if (entry)
          void copyToClipboard(entry.value).then((err) =>
            setCopied(err ? `copy failed: ${err}` : `copied ${entry.value}`),
          );
      } else if (input === 'u' && pane === 'denylist') {
        const entry = denyEntries[denyCursor];
        if (!entry || entry.removed) return;
        setConfirm({
          prompt: `Lift the deny on ${entry.value}?`,
          detail: `${entry.kind.toUpperCase()} · takes effect on apply`,
          onYes: () => unstageDeny(entry),
        });
        setFocus('confirm');
      } else if (pane === 'sitemap' && key.return) {
        // A JA4 is 37 characters that must be exact; retyping one is how a deny rule ends up
        // matching nothing.
        const d = sitemap.data?.digests[sitemapCursor];
        if (d) {
          void copyToClipboard(d.ja4).then((err) =>
            setCopied(err ? `copy failed: ${err}` : `copied ${d.ja4}`),
          );
        }
      } else if (pane === 'sitemap' && (key.upArrow || input === 'k')) {
        setSitemapCursor((c) => Math.max(0, c - 1));
        setCopied('');
      } else if (pane === 'sitemap' && (key.downArrow || input === 'j')) {
        setSitemapCursor((c) =>
          Math.min((sitemap.data?.digests.length ?? 1) - 1, c + 1),
        );
        setCopied('');
      } else if (input === 'o' && pane === 'sitemap') {
        // Straight to a profile: the copy exists so the digest can be pasted, but opening it
        // here skips the paste entirely.
        const d = sitemap.data?.digests[sitemapCursor];
        if (d) {
          setPickKind('ja4');
          setPane('ip');
          setReportScroll(0);
          ipTabs.open({ kind: 'ja4', value: d.ja4 }, ipWindow);
        }
      } else if (pane === 'watchlist' && key.return) {
        // Same reasoning as the sitemap pane: a JA4 is 37 characters that must be exact.
        const e = watchlist[watchlistCursor];
        if (e)
          void copyToClipboard(e.id).then((err) =>
            setCopied(err ? `copy failed: ${err}` : `copied ${e.id}`),
          );
      } else if (input === 'o' && pane === 'watchlist') {
        const e = watchlist[watchlistCursor];
        if (e) {
          setPickKind(e.kind);
          setPane('ip');
          setReportScroll(0);
          ipTabs.open({ kind: e.kind, value: e.id }, ipWindow);
        }
      } else if (input === 'x' && pane === 'watchlist') {
        // Removal is cheap to undo (mark it again), so no confirm — unlike lifting a deny.
        const e = watchlist[watchlistCursor];
        if (e) {
          const next = removeEntry(watchlist, e.kind, e.id);
          setWatchlist(next);
          setWatchlistCursor((c) => Math.max(0, Math.min(c, next.length - 1)));
          void saveList(ROOT, WATCHLIST_FILE, next).then((err) => {
            if (err) setCopied(`watch list: ${err}`);
          });
        }
      } else if (input === 'z' && pane === 'watchlist') {
        // The successor state: seen, judged, and not worth being told about again.
        const e = watchlist[watchlistCursor];
        if (e)
          void moveIdentity(
            'ignore',
            { kind: e.kind, value: e.id },
            e.note || 'moved from watch list',
          );
      } else if (pane === 'ignorelist' && key.return) {
        const e = ignoreList[ignoreCursor];
        if (e)
          void copyToClipboard(e.id).then((err) =>
            setCopied(err ? `copy failed: ${err}` : `copied ${e.id}`),
          );
      } else if (input === 'o' && pane === 'ignorelist') {
        // Ignored is muted, not invisible — a profile is still one keystroke away.
        const e = ignoreList[ignoreCursor];
        if (e) {
          setPickKind(e.kind);
          setPane('ip');
          setReportScroll(0);
          ipTabs.open({ kind: e.kind, value: e.id }, ipWindow);
        }
      } else if (input === 'x' && pane === 'ignorelist') {
        // Un-ignoring needs no ceremony: if it is still active, the next tick re-surfaces it.
        const e = ignoreList[ignoreCursor];
        if (e) {
          const next = removeEntry(ignoreList, e.kind, e.id);
          setIgnoreList(next);
          setIgnoreCursor((c) => Math.max(0, Math.min(c, next.length - 1)));
          void saveList(ROOT, IGNORELIST_FILE, next).then((err) => {
            if (err) setCopied(`ignore list: ${err}`);
          });
        }
      } else if (input === 'm' && pane === 'ignorelist') {
        const e = ignoreList[ignoreCursor];
        if (e)
          void moveIdentity(
            'watch',
            { kind: e.kind, value: e.id },
            e.note || 'moved from ignore list',
          );
      } else if (input === 'm' && pane === 'ip' && ipTabs.active) {
        void moveIdentity(
          'watch',
          ipTabs.active.subject,
          'marked from profile',
        );
      } else if (input === 'z' && pane === 'ip' && ipTabs.active) {
        void moveIdentity(
          'ignore',
          ipTabs.active.subject,
          'ignored from profile',
        );
      } else if (input === 'x' && pane === 'ip') {
        ipTabs.close();
        setReportScroll(0);
      } else if (PANE_KEY[input])
        openPane(PANE_KEY[input], input === 'f' ? 'ja4' : 'ip');
      else if (key.escape) setFocus('editor');
      else if (pane === 'denylist' && (key.upArrow || input === 'k')) {
        setDenyCursor((c) => Math.max(0, c - 1));
        setCopied('');
      } else if (pane === 'denylist' && (key.downArrow || input === 'j')) {
        setDenyCursor((c) => Math.min(denyEntries.length - 1, c + 1));
        setCopied('');
      } else if (pane === 'watchlist' && (key.upArrow || input === 'k')) {
        setWatchlistCursor((c) => Math.max(0, c - 1));
        setCopied('');
      } else if (pane === 'watchlist' && (key.downArrow || input === 'j')) {
        setWatchlistCursor((c) => Math.min(watchlist.length - 1, c + 1));
        setCopied('');
      } else if (pane === 'ignorelist' && (key.upArrow || input === 'k')) {
        setIgnoreCursor((c) => Math.max(0, c - 1));
        setCopied('');
      } else if (pane === 'ignorelist' && (key.downArrow || input === 'j')) {
        setIgnoreCursor((c) => Math.min(ignoreList.length - 1, c + 1));
        setCopied('');
      } else if (key.upArrow || input === 'k')
        setReportScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === 'j')
        setReportScroll((s) => Math.min(reportMaxScroll, s + 1));
      else if (key.pageUp) setReportScroll((s) => Math.max(0, s - reportH + 2));
      else if (key.pageDown)
        setReportScroll((s) => Math.min(reportMaxScroll, s + reportH - 2));
      return;
    }
    if (phase === 'select') {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === 'j')
        setCursor((c) => Math.min(items.length - 1, c + 1));
      else if (key.leftArrow || input === 'h') cycleCursorAction(-1);
      else if (key.rightArrow || input === 'l') cycleCursorAction(1);
      else if (key.return) {
        const opts = actionOptions(items[cursor].rule);
        setMenuCursor(Math.max(0, opts.indexOf(items[cursor].action)));
        setPhase('action');
      } else if (input === ' ')
        editCursorItem((it) => ({ ...it, active: !it.active }));
      // Lazy: fetch once, cached after, so re-opening a pane is instant.
      else if (PANE_KEY[input])
        openPane(PANE_KEY[input], input === 'f' ? 'ja4' : 'ip');
      // Bound here as well as in the pane branch: watch mode is meant to be armed and left, so
      // it has to be reachable from the view the tool opens on.
      else if (input === 'v' || input === 'V') setWatchOn((on) => !on);
      else if (key.tab && ipTabs.tabs.length) gotoIpTabs(key.shift ? -1 : 1);
      else if (input === 'a') {
        if (applying.current) return;
        applying.current = true;
        cancelApply.current = false; // a prior cancelled run must not abort this one
        setPhase('applying');
        void applyAll(items);
      } else if (input === 'q' || key.escape) exit();
    } else if (phase === 'action') {
      const opts = actionOptions(items[cursor].rule);
      if (key.upArrow || input === 'k')
        setMenuCursor((m) => Math.max(0, m - 1));
      else if (key.downArrow || input === 'j')
        setMenuCursor((m) => Math.min(opts.length - 1, m + 1));
      else if (key.return) {
        const chosen = opts[menuCursor];
        editCursorItem((it) => ({ ...it, action: chosen }));
        setPhase('select');
      } else if (key.escape || key.leftArrow) setPhase('select');
      else if (input === 'q') exit();
    } else if (phase === 'applying') {
      // Request cancellation; applyAll exits once it has stopped cleanly.
      if (input === 'q') cancelApply.current = true;
    } else if (phase === 'fatal') {
      if (input === 'q' || key.return || key.escape) exit();
    }
  });

  if (phase === 'loading') return <Text>Loading firewall config…</Text>;
  if (phase === 'fatal')
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load firewall config:</Text>
        <Text color="red">{error}</Text>
        <Text dimColor>q to quit</Text>
      </Box>
    );

  const onCount = items.filter((it) => it.active).length;
  const target = phase === 'action' ? items[cursor] : null;
  const cols = process.stdout.columns ?? 120;
  // 70% to the pane: it carries the reports, profiles and charts, while the rules list is names
  // and a tag. Floors both ways so a narrow terminal still shows a usable rule row.
  // MIN_RULES_W is reserved BEFORE the pane takes its share. Flooring the pane at MIN_PANE_W
  // after the cap inverted that: below 94 columns the floor won and the rules column shrank
  // past the width its rows are sized against, so Ink wrapped every row.
  const reportW = Math.min(
    cols - MIN_RULES_W - PANE_GAP,
    Math.max(MIN_PANE_W, Math.floor(cols * PANE_SHARE)),
  );
  // Too narrow for both: the rules list is the thing you cannot work without, so it keeps the
  // terminal and the pane waits for a wider window.
  const showPane = pane !== null && reportW >= MIN_PANE_W;
  // Tab chips are sized here so the bar can be windowed: overflowing the row makes Ink wrap it
  // and the entire bar disappears, leaving no sign of which tab is active.
  const tabBar = tabWindow(
    // brackets/spaces + trailing gap, plus the '…' a loading tab renders — a group that exactly
    // fits while idle would otherwise wrap the moment one of them refreshes.
    ipTabs.tabs.map((t) => tabLabel(t).length + (t.loading ? 4 : 3)),
    ipTabs.index,
    reportW,
  );
  const rulesW = showPane ? cols - reportW - PANE_GAP : cols;
  const longestName = items.reduce(
    (n, it) => Math.max(n, it.rule.name.length),
    0,
  );
  // ◂ n/m ▸ stays visible whenever there is somewhere to cycle to, even with the rules focused —
  // otherwise nothing on screen says the other lookups are still open.
  const showTabNav = pane === 'ip' && ipTabs.tabs.length > 1;
  const paneFooter = showTabNav || focus === 'pane';
  // Measured, not assumed: an IPv4 is 15 chars and a JA4 digest 36, so whether two columns fit
  // depends on what is actually listed. A row that wraps takes the whole Ink list with it, so
  // the quiet band stacks underneath when the width is not there.
  const { twoCol, rows: pickerRows } = pickerLayout(
    ipMatches.length,
    quietMatches.length,
    columnWidth(ipMatches, CAP_BUSIEST, isFlagged, isOpen, ROW_CHROME),
    columnWidth(quietMatches, CAP_QUIET, isFlagged, isOpen, ROW_CHROME),
    reportW - 4, // the pane's border and padding
    PANE_GAP,
  );
  // Rows the pane spends on its own tab bar / prompt / footer, so the bordered box stays inside the
  // viewport — an over-tall frame makes the terminal scroll and hides the editor cursor.
  const paneChrome =
    (pane === 'ip' && ipTabs.tabs.length ? 1 : 0) +
    // The suggestion overlay grows the prompt, so the box has to give back the same rows.
    (focus === 'ip-input' ? 3 + pickerRows : 0) +
    (focus === 'confirm' ? 3 : 0) +
    (focus === 'asn-input' ? 1 : 0) +
    (focus === 'range-input' ? 1 : 0) +
    // header + one row per preset + the custom row + the hint
    (focus === 'window-pick' ? WINDOW_PRESETS.length + 3 : 0) +
    (paneFooter ? 1 : 0) +
    (copied ? 1 : 0);
  return (
    <Box flexDirection="row">
      <Box
        flexDirection="column"
        width={rulesW}
        flexShrink={0}
        marginRight={showPane ? PANE_GAP : 0}
      >
        <Box>
          <Text bold>Vercel firewall rules </Text>
          <Text color={dryRun ? 'yellow' : 'green'}>
            {dryRun ? '(DRY-RUN)' : '(LIVE)'}
          </Text>
          <Text dimColor> · {projectId.slice(0, 12)}…</Text>
        </Box>
        <Box marginY={1} flexDirection="column">
          {items.map((it, i) => (
            <Row
              key={it.rule.name}
              item={it}
              isCursor={i === cursor && focus === 'editor'}
              phase={phase}
              width={rulesW}
              longestName={longestName}
              pending={pendingByRule.get(it.rule.name)}
            />
          ))}
        </Box>
        {phase === 'select' && (
          <Box flexDirection="column">
            {applied && (
              <Text color={applied.ok ? 'green' : 'red'}>
                {applied.ok ? '✔' : '✖'} applied — {applied.summary} · keep
                editing, or q to quit
              </Text>
            )}
            <Text dimColor>
              ↑/↓ move · ←/→ action · enter menu · space on/off · r report · i
              ip · f ja4 · s sitemap · d denylist · t watch-list · g ignore ·{' '}
              <Text color={watchOn ? 'green' : undefined} bold={watchOn}>
                v watch{watchOn ? ' (on)' : ''}
              </Text>
              {ipTabs.tabs.length ? ' · tab cycle ips' : ''}
              {paneLoading ? ' (loading…)' : ''} · a apply · q quit ({onCount}/
              {items.length} on)
              {pendingByRule.size ? (
                <Text color="yellow">
                  {' '}
                  · {pendingByRule.size} rule(s) unapplied
                </Text>
              ) : (
                ''
              )}
            </Text>
          </Box>
        )}
        {phase === 'action' && target && (
          <Box flexDirection="column">
            <Text>
              Action for <Text bold>{target.rule.name}</Text>:
            </Text>
            {actionOptions(target.rule).map((opt, i) => (
              <Box key={opt}>
                <Text color="cyan">{i === menuCursor ? '▶ ' : '  '}</Text>
                <Text color={actionColor(opt)}>
                  {opt.toUpperCase().padEnd(10)}
                </Text>
                <Text color="green">{opt === target.action ? '✔' : ' '}</Text>
              </Box>
            ))}
            {isLogOnly(target.rule) && (
              <Text dimColor>
                locked to log — JA4 is shared by many real users
              </Text>
            )}
            <Text dimColor>↑/↓ choose · enter set · esc cancel · q quit</Text>
          </Box>
        )}
        {phase === 'applying' && (
          <Text color="yellow">applying… · q stops after the current rule</Text>
        )}
        {watchOn && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={watchBusy ? 'yellow' : 'green'} bold>
                ◉ watch{' '}
              </Text>
              <Text dimColor>
                {watchTiming() ??
                  'window unset — set FW_WATCH_HOURS and FW_WATCH_INTERVAL_MIN'}
                {watchAt ? ` · last ${watchAt}` : ' · starting…'}
                {keepingAwake ? ' · holding the mac awake' : ''}
              </Text>
            </Text>
            {Boolean(watchNote) && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {watchNote}
              </Text>
            )}
            {/* Name them, or "1 profiled" sends the operator digging through the log. */}
            {watchWho.map((w) => (
              <Text key={w} dimColor wrap="truncate-end">
                {'    '}
                {w}
              </Text>
            ))}
            {/* Stays up once it has happened. The loop runs while you are in another pane, so an
                invocation you were not watching still has to be visible afterwards. */}
            {invokedCount > 0 && (
              <Text>
                <Text color="magenta" bold>
                  {'  '}⇢ claude invoked{' '}
                </Text>
                <Text dimColor>
                  {invokedCount}× this session · last {invokedAt}
                  {notifiedAt ? ` · notified ${notifiedAt}` : ''} · {WATCH_LOG}
                </Text>
              </Text>
            )}
            {invokedCount === 0 && Boolean(watchAt) && (
              <Text dimColor>
                {'  '}logging to {WATCH_LOG}
              </Text>
            )}
            {/* Not truncated: a verdict is the one thing here worth reading in full, and a
                clipped one is worse than none — it reads as complete. */}
            {Boolean(watchVerdict) && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="cyan" bold>
                  investigation{' '}
                  {watchVerdictOf ? (
                    <Text dimColor>{watchVerdictOf}</Text>
                  ) : null}
                </Text>
                {/* Clamped. This pane's height is reserved in advance, and an unbounded verdict
                    overflows the frame — which scrolls the terminal and hides the editor cursor,
                    the same defect reportH and the pane height already exist to prevent. */}
                <Text>{verdictHead}</Text>
                {verdictClipped > 0 && (
                  <Text dimColor>
                    {'  '}… {verdictClipped} more line(s) — full text in{' '}
                    {WATCH_LOG}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
      {showPane && (
        <Box flexDirection="column" width={reportW}>
          {pane === 'ip' && ipTabs.tabs.length > 0 && (
            <Box>
              {isLive && (
                <Text color={blink ? 'red' : 'gray'} bold>
                  ●{' '}
                </Text>
              )}
              {tabBar.left && (
                <Text color="cyan" bold>
                  ‹{' '}
                </Text>
              )}
              {ipTabs.tabs.slice(tabBar.start, tabBar.end).map((t, j) => {
                const i = tabBar.start + j;
                const chip =
                  i === ipTabs.index ? `[${tabLabel(t)}]` : ` ${tabLabel(t)} `;
                return (
                  <Text
                    key={`${t.subject.kind}:${t.subject.value}`}
                    bold={i === ipTabs.index}
                    color={i === ipTabs.index ? 'cyan' : undefined}
                    dimColor={i !== ipTabs.index}
                    // Clips a lone chip too wide for the row; without this it wraps and Ink
                    // loses the whole bar.
                    wrap="truncate-end"
                  >
                    {chip}
                    {t.loading ? '…' : ''}{' '}
                  </Text>
                );
              })}
              {tabBar.right && (
                <Text color="cyan" bold>
                  {' '}
                  ›
                </Text>
              )}
            </Box>
          )}
          <Box
            flexDirection="column"
            // Floored: reportH bottoms out at 8 while the picker's chrome can exceed that on a
            // short terminal, and a negative height is not a smaller box, it is a broken frame.
            height={Math.max(0, reportH - paneChrome)}
            borderStyle="round"
            borderColor={focus === 'editor' ? 'gray' : 'cyan'}
            paddingX={1}
            overflowY="hidden"
          >
            <Box
              ref={reportRef}
              flexDirection="column"
              flexShrink={0}
              marginTop={-reportScroll}
            >
              <PaneBody
                kind={pane}
                width={reportW - 4}
                report={report}
                ipTab={ipTabs.active}
                sitemap={sitemap}
                advice={ipAdvice}
                sitemapCursor={sitemapCursor}
                denyEntries={denyEntries}
                denyNotEnforcing={denyNotEnforcing}
                denyActivityNote={denyActivityNote}
                denyCursor={denyCursor}
                denyActivity={denyActivity}
                watchEntries={watchlist}
                watchError={watchlistError}
                watchCursor={watchlistCursor}
                ignoreEntries={ignoreList}
                ignoreError={ignoreError}
                ignoreCursor={ignoreCursor}
              />
            </Box>
          </Box>
          {copied && (
            <Text
              color={
                copied.startsWith('copy failed') ||
                copied.startsWith('watch list:') ||
                copied.startsWith('ignore list:')
                  ? 'red'
                  : 'green'
              }
            >
              {copied}
            </Text>
          )}
          {paneFooter && (
            <Box>
              {showTabNav && (
                <Text>
                  <Text color="cyan" bold>
                    ◂{' '}
                  </Text>
                  <Text bold>
                    {ipTabs.index + 1}/{ipTabs.tabs.length}
                  </Text>
                  <Text color="cyan" bold>
                    {' '}
                    ▸
                  </Text>
                  <Text dimColor> tab/shift-tab · </Text>
                </Text>
              )}
              {focus === 'pane' && (
                <Text dimColor>
                  j/k{' '}
                  {pane === 'denylist' ||
                  pane === 'watchlist' ||
                  pane === 'ignorelist'
                    ? 'select'
                    : 'scroll'}{' '}
                  · R refresh · i new ip · f ja4 · t watch-list · g ignore · w
                  timeline · v watch
                  {watchOn ? ' (on)' : ''}
                  {/* Shown exactly when `b` does something: the advisor offered a lever. */}
                  {pane === 'ip' && ipAdvice?.lever
                    ? ` · b deny ${ipAdvice.lever.kind === 'ja4' ? 'fingerprint' : 'network'}`
                    : ''}
                  {pane === 'denylist' ? ' · enter copy · u unban' : ''}
                  {pane === 'sitemap' ? ' · enter copy · o profile it' : ''}
                  {pane === 'watchlist'
                    ? ' · enter copy · o profile it · z ignore · x remove'
                    : ''}
                  {pane === 'ignorelist'
                    ? ' · enter copy · o profile it · m watch it · x remove'
                    : ''}
                  {pane === 'ip' ? ' · m watch · z ignore · x close tab' : ''} ·
                  esc rules
                </Text>
              )}
            </Box>
          )}
          {focus === 'window-pick' && (
            <Box flexDirection="column">
              <Text dimColor>{'  '}timeline</Text>
              {WINDOW_PRESETS.map((p, i) => (
                <Box key={p.label}>
                  <Text color="cyan">{i === windowCursor ? '▶ ' : '  '}</Text>
                  <Text
                    bold={i === windowCursor}
                    color={i === windowCursor ? 'cyan' : undefined}
                    dimColor={i !== windowCursor}
                  >
                    {p.label.padEnd(10)}
                  </Text>
                  <Text dimColor>
                    {p.minutes < 60 ? `${p.minutes}m` : `${p.minutes / 60}h`}
                    {i === presetIdx ? '  ·  in force' : ''}
                  </Text>
                </Box>
              ))}
              <Box>
                <Text color="cyan">
                  {windowCursor >= WINDOW_PRESETS.length ? '▶ ' : '  '}
                </Text>
                <Text
                  bold={windowCursor >= WINDOW_PRESETS.length}
                  color={
                    windowCursor >= WINDOW_PRESETS.length ? 'cyan' : undefined
                  }
                  dimColor={windowCursor < WINDOW_PRESETS.length}
                >
                  {'custom…'.padEnd(10)}
                </Text>
                <Text dimColor>
                  type dates{presetIdx < 0 ? '  ·  in force' : ''}
                </Text>
              </Box>
              <Text dimColor>{'  '}↑↓ choose · enter apply · esc cancel</Text>
            </Box>
          )}
          {focus === 'range-input' && (
            <Box>
              <Text color="cyan">range: </Text>
              <Text>{rangeInput}</Text>
              <Text color="cyan">▏</Text>
              <Text dimColor>
                {rangeError
                  ? `  ${rangeError}`
                  : `  e.g. 08 02 2026 - 08 04 2026 · one date = that day to now · blank = last ${IP_WINDOW_HOURS}h`}
              </Text>
            </Box>
          )}
          {focus === 'asn-input' && (
            <Box>
              <Text color="cyan">AS number for {ipAdvice?.lever?.value}: </Text>
              <Text>{asnInput}</Text>
              <Text color="cyan">▏</Text>
              <Text dimColor>
                {asnError ? `  ${asnError}` : '  enter confirm · esc cancel'}
              </Text>
            </Box>
          )}
          {focus === 'confirm' && confirm && (
            <Box flexDirection="column">
              <Text color="yellow" bold>
                {confirm.prompt}
              </Text>
              <Box>
                <Text dimColor>{confirm.detail}</Text>
              </Box>
              <Text>
                <Text color="yellow" bold>
                  y
                </Text>
                <Text dimColor> yes · </Text>
                <Text bold>n</Text>
                <Text dimColor> no (esc cancels)</Text>
              </Text>
            </Box>
          )}
          {focus === 'ip-input' && (
            <Box flexDirection="column">
              {pickList.loading && !pickList.data ? (
                <Text dimColor>
                  {'  '}loading busiest{' '}
                  {pickKind === 'ip' ? 'IPs' : 'fingerprints'}…
                </Text>
              ) : (
                pickList.data && (
                  <Text dimColor>
                    {'  '}busiest{' '}
                    {pickKind === 'ip' ? 'IPs' : 'JA4 fingerprints'} ·{' '}
                    {ipWindow.label} ·{' '}
                    {ipInput
                      ? `${ipFiltered.length} match` +
                        (ipFiltered.length > ipMatches.length
                          ? `, showing ${ipMatches.length}`
                          : '')
                      : `top ${ipMatches.length} of ${pickList.data.length}` +
                        // A full list means the API's group cap was reached, and it truncates
                        // silently. The quiet band is drawn from the bottom of what came back,
                        // which is then not the bottom of the traffic — say so rather than let
                        // a partial answer read as the whole picture.
                        (pickList.data.length >= TOP_IPS_LIMIT
                          ? ' (capped)'
                          : '') +
                        (isLive
                          ? ` · auto-refresh ${LIVE_REFRESH_MS / 1000}s${failuresRef.current ? ' (backing off)' : ''}`
                          : ', type to filter') +
                        // Names the bound rather than saying "all": the list above can now be
                        // longer than what one keypress will open.
                        ` · o open top ${Math.min(OPEN_ALL_MAX, ipMatches.length)} · w timeline`}
                  </Text>
                )
              )}
              {twoCol ? (
                <Box>
                  <Box flexDirection="column" marginRight={PANE_GAP}>
                    <Text dimColor>
                      {'  '}
                      {CAP_BUSIEST}
                    </Text>
                    {ipMatches.map(pickerRow)}
                  </Box>
                  <Box flexDirection="column">
                    <Text dimColor>
                      {'  '}
                      {CAP_QUIET}
                    </Text>
                    {quietMatches.map((r, i) =>
                      pickerRow(r, ipMatches.length + i),
                    )}
                  </Box>
                </Box>
              ) : (
                <>
                  {ipMatches.map(pickerRow)}
                  {quietMatches.length > 0 && (
                    <Text dimColor>
                      {'  '}
                      {CAP_QUIET} requests, lowest first
                    </Text>
                  )}
                  {quietMatches.map((r, i) =>
                    pickerRow(r, ipMatches.length + i),
                  )}
                </>
              )}
              {Boolean(pickList.data) && !ipMatches.length && ipInput && (
                <Text dimColor>
                  {' '}
                  no busy {pickKind === 'ip' ? 'IP' : 'fingerprint'} matches —
                  enter profiles it anyway
                </Text>
              )}
              <Box>
                <Text color="cyan">{pickKind === 'ip' ? 'IP: ' : 'JA4: '}</Text>
                <Text>{ipInput}</Text>
                <Text color="cyan">▏</Text>
                <Text dimColor>
                  {ipError
                    ? `  ${ipError}`
                    : '  ↑↓ pick · enter profile · esc cancel'}
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/** A tab's chip text. A JA4 is 37 chars, so it is shortened to its distinguishing head. */
function tabLabel(t: IpTab): string {
  return t.subject.kind === 'ja4'
    ? `${t.subject.value.slice(0, 14)}…`
    : t.subject.value;
}

/** Body of whichever side pane is open. Report keeps its bespoke Ink view; the other two share the line model. */
function PaneBody({
  kind,
  width,
  report,
  ipTab,
  sitemap,
  advice,
  sitemapCursor,
  denyEntries,
  denyNotEnforcing,
  denyActivityNote,
  denyCursor,
  denyActivity,
  watchEntries,
  watchError,
  watchCursor,
  ignoreEntries,
  ignoreError,
  ignoreCursor,
}: {
  kind: PaneKind;
  width: number;
  report: Pane<ReportData>;
  ipTab: IpTab | undefined;
  sitemap: Pane<SitemapReport>;
  advice: Advice | undefined;
  sitemapCursor: number;
  denyEntries: DenyEntry[];
  denyNotEnforcing: { rule: string; why: string }[];
  denyActivityNote: string;
  denyCursor: number;
  denyActivity: Pane<Map<string, Activity>>;
  watchEntries: WatchlistEntry[];
  watchError: string;
  watchCursor: number;
  ignoreEntries: WatchlistEntry[];
  ignoreError: string;
  ignoreCursor: number;
}) {
  if (kind === 'report')
    return (
      <ReportView
        report={report.data}
        error={report.error}
        loading={report.loading}
      />
    );
  if (kind === 'denylist')
    return (
      <Lines
        lines={denylistLines(
          {
            windowHours: DENY_ACTIVITY_HOURS,
            entries: denyEntries,
            notEnforcing: denyNotEnforcing,
            error: denyActivity.error || denyActivityNote || undefined,
          },
          denyCursor,
        )}
        width={width}
      />
    );
  if (kind === 'watchlist')
    return (
      <Lines
        lines={watchlistLines(
          { entries: watchEntries, error: watchError || undefined },
          watchCursor,
          Date.now(),
        )}
        width={width}
      />
    );
  if (kind === 'ignorelist')
    return (
      <Lines
        lines={ignoreListLines(
          { entries: ignoreEntries, error: ignoreError || undefined },
          ignoreCursor,
          Date.now(),
        )}
        width={width}
      />
    );
  const what = kind === 'ip' ? 'IP profile' : 'sitemap readers';
  const state = kind === 'ip' ? ipTab : sitemap;
  if (!state) return <Text dimColor>no {what} yet — i to look one up</Text>;
  if (state.error) return <Text color="red">{state.error}</Text>;
  if (!state.data)
    return (
      <Text dimColor>
        {state.loading ? `Loading ${what}…` : `no ${what} yet`}
      </Text>
    );
  return (
    <Box flexDirection="column">
      {state.loading && <Text dimColor>refreshing…</Text>}
      <Lines
        lines={
          kind === 'ip'
            ? profileLines(
                withAllowlistError((ipTab as IpTab).data as IpProfile),
                width,
                advice,
              )
            : sitemapLines(sitemap.data as SitemapReport, sitemapCursor)
        }
        width={width}
      />
    </Box>
  );
}
