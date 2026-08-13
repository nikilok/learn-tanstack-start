// The interactive rule-manager TUI: a stateful Ink container wiring the data layer
// (client.ts, report-data.ts) to the presentational components in ./components.

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
import { adviseBan } from './ban-advice';
import { applyItem, fetchLive, projectId, teamId, token } from './client';
import { copyToClipboard } from './clipboard';
import { ConfirmPrompt } from './components/confirm-prompt';
import {
  FooterHints,
  type MaybeHint,
  hintRows,
} from './components/footer-hints';
import { IdentityPicker } from './components/identity-picker';
import { PaneBody } from './components/pane-body';
import { type Phase, Row, summaryLine } from './components/rule-list';
import { TabBar, tabLabel } from './components/tab-bar';
import { WatchStatus } from './components/watch-status';
import { WindowPicker } from './components/window-picker';
import { ASN_DENY } from './deny-list';
import { promotes } from './deny-staging';
import { useDenylist } from './hooks/useDenylist';
import { useIdentityLists } from './hooks/useIdentityLists';
import { tabWindow, useIpTabs } from './hooks/useIpTabs';
import { usePane } from './hooks/usePane';
import { CAP_BUSIEST, CAP_QUIET, usePickers } from './hooks/usePickers';
import { useWatch } from './hooks/useWatch';
import { columnWidth, noAlpn, pickerLayout } from './identity-list';
import { moveCursor, resolveIpEntry } from './ip-entry';
import type { Subject } from './ip-profile';
import { fingerprintScopeNote, overrideWarning } from './ip-profile-view';
import {
  type Binding,
  type PaneKind,
  type Press,
  bindingFor,
  hintsFor,
  isUp,
  press,
} from './pane-keys';
import {
  COUNT_W,
  MIN_PANE_W,
  MIN_RULES_W,
  PANE_GAP,
  PANE_SHARE,
  ROW_CHROME,
} from './pane-layout';
import { resolveSubject, subjectsToOpen, typeIdentity } from './pick-input';
import { type ReportData, fetchReport } from './report-data';
import { trustedRules } from './rule-integrity';
import { dryRun, rules } from './rules';
import { type ApplyStatus, type Item, seedItems } from './seed-items';
import { type SitemapReport, fetchSitemapReport } from './sitemap-readers';
import {
  LIVE_MINUTES,
  type Window,
  WINDOW_PRESETS,
  rollingMinutes,
  rollingWindow,
} from './time-window';
import { allowedBotsOrUnknown } from './tuning';
import { errMsg } from './util';
import type { ListSide, WatchlistEntry } from './watchlist';
import {
  isCustomRow,
  moveWindowCursor,
  openCursor,
  rangeSelection,
  submitsOnPaste,
  typeRange,
} from './window-pick';

const PANE_KEY: Record<string, PaneKind> = {
  r: 'report',
  i: 'ip',
  f: 'ip', // same pane, fingerprint picker
  s: 'sitemap',
  d: 'denylist',
  t: 'watchlist',
  g: 'ignorelist',
};
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

// `o` opens each listed subject at ~21 observability queries, against an endpoint measured to
// sustain ~60/min. It stays fixed while the list above it grows, or one keypress rate-limits the
// tool against itself.
const OPEN_ALL_MAX = 8;

/** Interactive firewall manager: toggle each rule on/off and switch its action (log/challenge/deny/bypass), view the report in a side pane, then apply (upsert) to Vercel. */
export function App() {
  const { exit } = useApp();
  const creds = { projectId, teamId, token };
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
  // Bound the report pane to the terminal height so the rendered frame never exceeds the viewport —
  // otherwise a tall report makes the terminal itself scroll and the editor cursor disappears above it.
  const reportH = Math.max(8, (process.stdout.rows ?? 24) - 1);
  const pickers = usePickers(reportH);
  // The live loop is armed once, so it reaches the picker through a ref rather than a closure.
  const pickersRef = useRef(pickers);
  pickersRef.current = pickers;
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
  const denylist = useDenylist({
    items,
    setItems,
    onEdit: () => setApplied(null),
  });
  const [sitemapCursor, setSitemapCursor] = useState(0);
  const [copied, setCopied] = useState('');
  const lists = useIdentityLists(ROOT);
  const watch = useWatch({ creds, onWatchlist: lists.replaceWatch });
  const [confirm, setConfirm] = useState<{
    prompt: string;
    detail: string;
    onYes: () => void;
  } | null>(null);
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
    // The list panes load and grow asynchronously; without these a long list is clamped to the
    // height it had while still loading and can never be scrolled to.
    lists.watch.entries,
    lists.ignore.entries,
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
        const outcome = await pickersRef.current.refreshLive(creds, w);
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
      const cancelledPersist = denylist.persist(snapshot, outcome, dryRun);
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
    const persisted = denylist.persist(snapshot, outcome, dryRun);
    // Set both ways: a retry that succeeds after a failed apply must not still exit non-zero.
    process.exitCode = anyError || !persisted.ok ? 1 : 0;
    // Back to the editor, not a terminal screen — an apply is a step in a session.
    setApplied({
      summary: summaryLine(statuses) + persisted.summary,
      ok: !anyError && persisted.ok,
    });
    setPhase('select');
  };

  const subjectDigest = ipTabs.active?.data
    ? ipTabs.active.data.subject.kind === 'ja4'
      ? ipTabs.active.data.subject.value
      : (ipTabs.active.data.byJa4[0]?.[0] ?? '')
    : '';

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
        alreadyDeniedJa4: denylist.enforcedJa4(subjectDigest),
        challengedJa4: denylist.challengedJa4(subjectDigest),
        stagedJa4: denylist.stagedJa4(subjectDigest),
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

  // Shared with the width measurement above, so a row can never be drawn wider than it was
  // measured — which is what wraps a row and costs the pane an unreserved line.
  const isOpen = (id: string) =>
    ipTabs.tabs.some((t) => t.subject.value === id);
  /** Free, and independent of volume. Not a verdict — a verified crawler inverts the same tell. */
  const isFlagged = (id: string) => pickers.kind === 'ja4' && noAlpn(id);

  /** One picker row. `i` indexes pickers.pickable, so the cursor means the same thing in both columns. */
  const pickerRow = ([id, count]: [string, number], i: number) => {
    const open = isOpen(id);
    const tell = isFlagged(id);
    return (
      <Box key={id}>
        <Text color="cyan">{i === pickers.cursor ? '▶ ' : '  '}</Text>
        <Text dimColor>{String(count).padStart(COUNT_W)} </Text>
        <Text
          bold={i === pickers.cursor}
          color={i === pickers.cursor ? 'cyan' : tell ? 'yellow' : undefined}
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
      pickers.begin(pick);
      setFocus('ip-input');
      // Picking from live traffic beats typing an address from memory. Fetched once per session.
      pickers.load(creds, pick, ipWindow);
      return;
    }
    setFocus('pane');
    if (kind === 'report' && !report.data)
      void report.load(() => fetchReport(creds));
    // Always re-read: the file is local, and the watch tick or a CLI run may have fed it since.
    if (kind === 'watchlist') void lists.load('watch');
    if (kind === 'ignorelist') void lists.load('ignore');
    if (kind === 'sitemap' && !sitemap.data)
      void sitemap.load(() => fetchSitemapReport(creds, ipWindow));
    if (kind === 'denylist' && !denylist.activity.data)
      denylist.loadActivity(creds);
  };

  /** Tab from elsewhere surfaces the IP tabs at the one you were last on; only a second press moves. Advancing straight away would skip a tab you had not seen yet. */
  const gotoIpTabs = (dir: 1 | -1) => {
    setReportScroll(0);
    setFocus('pane');
    if (pane === 'ip') ipTabs.cycle(dir);
    else setPane('ip');
  };

  /** Switch the window: refetch the picker list and re-profile the tab on screen, so flipping timelines is one key. */
  const applyWindow = (w: Window) => {
    setIpWindow(w);
    setRangeError('');
    pickers.reset();
    pickers.load(creds, pickers.kind, w, true);
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
    setWindowCursor(openCursor(presetIdx));
    windowReturn.current = focus === 'ip-input' ? 'ip-input' : 'pane';
    setFocus('window-pick');
  };

  /** Apply the highlighted timeline. The row past the presets is the custom date range. */
  const chooseWindow = () => {
    if (isCustomRow(windowCursor)) {
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
    const next = rangeSelection(raw, new Date(), IP_WINDOW_HOURS);
    if ('error' in next) {
      setRangeError(next.error);
      return;
    }
    setPresetIdx(next.presetIdx);
    applyWindow(next.window);
    // Back to whoever opened the picker, matching preset selection. Choosing a range from the
    // report or sitemap pane used to drop the operator into the IP picker instead.
    if (windowReturn.current === 'ip-input') {
      pickers.setInput('');
      pickers.setCursor(-1);
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
    const subjects = subjectsToOpen(
      pickers.busiest,
      pickers.kind,
      OPEN_ALL_MAX,
    );
    if (!subjects.length) return;
    pickers.setError('');
    setFocus('pane');
    setReportScroll(0);
    ipTabs.openMany(subjects, ipWindow);
  };

  /** Copy an exact identity. A JA4 is 37 characters that must be exact, and retyping one is how a deny ends up matching nothing. */
  const copyValue = (value: string | undefined) => {
    if (!value) return;
    void copyToClipboard(value).then((err) =>
      setCopied(err ? `copy failed: ${err}` : `copied ${value}`),
    );
  };

  /** Surface a list-save failure, which is the only thing those calls report. */
  const noteIfError = (err?: string) => {
    if (err) setCopied(err);
  };

  /** Open an identity as a profile tab from whichever pane named it. */
  const profileIdentity = (subject: Subject) => {
    pickers.setKind(subject.kind);
    setPane('ip');
    setReportScroll(0);
    ipTabs.open(subject, ipWindow);
  };

  /** Same, for a row on one of the lists. */
  const profileEntry = (e: WatchlistEntry | undefined) => {
    if (e) profileIdentity({ kind: e.kind, value: e.id });
  };

  /** Move a listed identity to the other list, keeping whatever note it carried. */
  const moveEntry = (
    to: ListSide,
    e: WatchlistEntry | undefined,
    fallback: string,
  ) => {
    if (!e) return;
    void lists
      .move(to, { kind: e.kind, value: e.id }, e.note || fallback)
      .then(setCopied);
  };

  /**
   * Stage a deny for the profile on screen, after a confirm.
   *
   * The advisory ADVISES; it does not hold the keys. This used to require an OFFERED lever and
   * then return silently on any blocker, so `b` did nothing at all unless the verdict was `ban` —
   * and a keypress that silently does nothing reads as a broken tool, not as a refusal. The
   * protection that matters is on the UNATTENDED path (`autoBanRefusal`), which still fires only
   * on `ban`. So the veto became a warning.
   */
  const denyFromProfile = () => {
    const lever = ipAdvice?.lever;
    if (lever?.kind === 'asn') {
      // The AS number is not derivable from the name observability reports.
      setAsnInput('');
      setAsnError('');
      setFocus('asn-input');
      return;
    }
    // A recommended lever names its own target; otherwise it is the subject's own digest.
    const target = lever?.value ?? subjectDigest;
    if (!target) {
      // Reachable while a tab is still loading, so it needs to say something rather than fall
      // through to the same silence this exists to remove.
      setCopied('nothing to deny — this profile carries no fingerprint yet');
      return;
    }
    const recommended = ipAdvice?.verdict === 'ban' && Boolean(lever);
    const subject = ipTabs.active?.data?.subject;
    const promoting = promotes(denylist.live.challengeValues, target);
    setConfirm({
      prompt: promoting
        ? `PROMOTE ${target} from challenge to DENY?`
        : `Deny TLS fingerprint ${target}?`,
      detail: [
        recommended
          ? `${ipAdvice?.reasons.length ?? 0} tells agree`
          : ipAdvice
            ? overrideWarning(ipAdvice)
            : 'no advice was computed for this identity',
        subject ? fingerprintScopeNote(subject, target) : '',
        promoting
          ? 'moves it to FW_BLOCKED_JA4 and OFF FW_CHALLENGE_JA4 in one apply — an interstitial becomes a hard 403'
          : 'stages into FW_BLOCKED_JA4',
      ]
        .filter(Boolean)
        .join(' · '),
      onYes: () => denylist.stageDeny('ja4', target),
    });
    setFocus('confirm');
  };

  /** Re-query whatever is on screen, so a pane is never stuck on a stale answer. */
  const refreshPane = () => {
    if (pane === 'report') void report.load(() => fetchReport(creds));
    else if (pane === 'watchlist') void lists.load('watch');
    else if (pane === 'ignorelist') void lists.load('ignore');
    else if (pane === 'sitemap')
      void sitemap.load(() => fetchSitemapReport(creds, ipWindow));
    else if (pane === 'ip') ipTabs.refresh();
    else if (pane === 'denylist') denylist.loadActivity(creds);
  };

  /** Open `value` as a tab; keeps focus in the field when it is not an IP. Takes the value rather than reading state, so a paste that ends in a newline can submit what it just appended. */
  const submitIp = (value: string) => {
    const out = resolveSubject(pickers.kind, value);
    if ('error' in out) {
      pickers.setError(out.error);
      return;
    }
    pickers.setError('');
    setFocus('pane');
    setReportScroll(0);
    ipTabs.open(out.subject, ipWindow);
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

  // Every side-pane key, in precedence order: the first match wins, so a pane-specific binding
  // sits above the general one it would otherwise be shadowed by.
  const paneBindings: Binding[] = [
    {
      key: 'j/k',
      label: 'select',
      panes: ['sitemap'],
      matches: (p) => press.up(p) || press.down(p),
      run: (p) => {
        setSitemapCursor((c) =>
          isUp(p)
            ? Math.max(0, c - 1)
            : Math.min((sitemap.data?.digests.length ?? 1) - 1, c + 1),
        );
        setCopied('');
      },
    },
    {
      key: 'j/k',
      label: 'select',
      panes: ['denylist'],
      matches: (p) => press.up(p) || press.down(p),
      run: (p) => {
        denylist.moveCursor(isUp(p) ? -1 : 1);
        setCopied('');
      },
    },
    {
      key: 'j/k',
      label: 'select',
      panes: ['watchlist'],
      matches: (p) => press.up(p) || press.down(p),
      run: (p) => {
        lists.moveCursor('watch', isUp(p) ? -1 : 1);
        setCopied('');
      },
    },
    {
      key: 'j/k',
      label: 'select',
      panes: ['ignorelist'],
      matches: (p) => press.up(p) || press.down(p),
      run: (p) => {
        lists.moveCursor('ignore', isUp(p) ? -1 : 1);
        setCopied('');
      },
    },
    {
      key: 'j/k',
      label: 'scroll',
      panes: ['report', 'ip'],
      matches: (p) => press.up(p) || press.down(p),
      run: (p) =>
        setReportScroll((sc) =>
          isUp(p) ? Math.max(0, sc - 1) : Math.min(reportMaxScroll, sc + 1),
        ),
    },
    {
      key: 'pgup/pgdn',
      label: 'page',
      // Every pane, including the list ones: j/k moves their cursor, so paging the body is the
      // only way to reach a row past the fold.
      unlisted: true,
      matches: (p) => press.pageUp(p) || press.pageDown(p),
      run: (p) =>
        setReportScroll((sc) =>
          p.pageUp
            ? Math.max(0, sc - reportH + 2)
            : Math.min(reportMaxScroll, sc + reportH - 2),
        ),
    },
    { key: 'R', label: 'refresh', matches: press.char('R'), run: refreshPane },
    {
      key: 'i',
      label: 'new ip',
      matches: press.char('i'),
      run: () => openPane('ip', 'ip'),
    },
    {
      key: 'f',
      label: 'ja4',
      matches: press.char('f'),
      run: () => openPane('ip', 'ja4'),
    },
    {
      key: 't',
      label: 'watch-list',
      matches: press.char('t'),
      run: () => openPane('watchlist'),
    },
    {
      key: 'g',
      label: 'ignore',
      matches: press.char('g'),
      run: () => openPane('ignorelist'),
    },
    {
      key: 'w',
      label: 'timeline',
      matches: press.char('w', 'W'),
      run: openWindowPick,
    },
    {
      key: 'v',
      label: watch.on ? 'watch (on)' : 'watch',
      active: watch.on,
      matches: press.char('v', 'V'),
      run: () => watch.toggle(),
    },
    {
      key: 'b',
      label: `deny ${ipAdvice?.lever?.kind === 'asn' ? 'network' : 'fingerprint'}`,
      panes: ['ip'],
      matches: press.char('b'),
      run: denyFromProfile,
    },
    {
      key: 'enter',
      label: 'copy',
      panes: ['denylist'],
      matches: press.enter,
      run: () => copyValue(denylist.entries[denylist.cursor]?.value),
    },
    {
      key: 'u',
      label: 'unban',
      panes: ['denylist'],
      matches: press.char('u'),
      run: () => {
        const entry = denylist.entries[denylist.cursor];
        if (!entry || entry.removed) return;
        setConfirm({
          prompt: `Lift the deny on ${entry.value}?`,
          detail: `${entry.kind.toUpperCase()} · takes effect on apply`,
          onYes: () => denylist.unstageDeny(entry),
        });
        setFocus('confirm');
      },
    },
    {
      key: 'enter',
      label: 'copy',
      panes: ['sitemap'],
      matches: press.enter,
      run: () => copyValue(sitemap.data?.digests[sitemapCursor]?.ja4),
    },
    {
      key: 'o',
      label: 'profile it',
      panes: ['sitemap'],
      // Straight to a profile: the copy exists so the digest can be pasted, but opening it here
      // skips the paste entirely.
      matches: press.char('o'),
      run: () => {
        const d = sitemap.data?.digests[sitemapCursor];
        if (d) profileIdentity({ kind: 'ja4', value: d.ja4 });
      },
    },
    {
      key: 'enter',
      label: 'copy',
      panes: ['watchlist'],
      matches: press.enter,
      run: () => copyValue(lists.watch.current?.id),
    },
    {
      key: 'o',
      label: 'profile it',
      panes: ['watchlist'],
      matches: press.char('o'),
      run: () => profileEntry(lists.watch.current),
    },
    {
      key: 'z',
      label: 'ignore',
      panes: ['watchlist'],
      // The successor state: seen, judged, and not worth being told about again.
      matches: press.char('z'),
      run: () =>
        moveEntry('ignore', lists.watch.current, 'moved from watch list'),
    },
    {
      key: 'x',
      label: 'remove',
      panes: ['watchlist'],
      // Removal is cheap to undo (mark it again), so no confirm — unlike lifting a deny.
      matches: press.char('x'),
      run: () => void lists.removeAtCursor('watch').then(noteIfError),
    },
    {
      key: 'enter',
      label: 'copy',
      panes: ['ignorelist'],
      matches: press.enter,
      run: () => copyValue(lists.ignore.current?.id),
    },
    {
      key: 'o',
      label: 'profile it',
      panes: ['ignorelist'],
      // Ignored is muted, not invisible — a profile is still one keystroke away.
      matches: press.char('o'),
      run: () => profileEntry(lists.ignore.current),
    },
    {
      key: 'm',
      label: 'watch it',
      panes: ['ignorelist'],
      matches: press.char('m'),
      run: () =>
        moveEntry('watch', lists.ignore.current, 'moved from ignore list'),
    },
    {
      key: 'x',
      label: 'remove',
      panes: ['ignorelist'],
      // Un-ignoring needs no ceremony: if it is still active, the next tick re-surfaces it.
      matches: press.char('x'),
      run: () => void lists.removeAtCursor('ignore').then(noteIfError),
    },
    {
      key: 'm',
      label: 'watch',
      panes: ['ip'],
      when: Boolean(ipTabs.active),
      matches: press.char('m'),
      run: () => {
        if (ipTabs.active)
          void lists
            .move('watch', ipTabs.active.subject, 'marked from profile')
            .then(setCopied);
      },
    },
    {
      key: 'z',
      label: 'ignore',
      panes: ['ip'],
      when: Boolean(ipTabs.active),
      matches: press.char('z'),
      run: () => {
        if (ipTabs.active)
          void lists
            .move('ignore', ipTabs.active.subject, 'ignored from profile')
            .then(setCopied);
      },
    },
    {
      key: 'x',
      label: 'close tab',
      panes: ['ip'],
      when: ipTabs.tabs.length > 0,
      matches: press.char('x'),
      run: () => {
        ipTabs.close();
        setReportScroll(0);
      },
    },
    {
      key: 'esc',
      label: 'rules',
      matches: press.escape,
      run: () => setFocus('editor'),
    },
    // Unlisted below. The tab indicator names its own keys, quit is on the rules footer, and
    // r/s/d are reachable from there too — the pane footer has no room to repeat them.
    {
      key: 'tab',
      label: 'cycle ips',
      unlisted: true,
      when: ipTabs.tabs.length > 0,
      matches: press.tab,
      run: (p) => gotoIpTabs(p.shift ? -1 : 1),
    },
    {
      key: 'q',
      label: 'quit',
      unlisted: true,
      matches: press.char('q'),
      run: exit,
    },
    {
      key: 'r',
      label: 'report',
      unlisted: true,
      matches: press.char('r'),
      run: () => openPane('report'),
    },
    {
      key: 's',
      label: 'sitemap',
      unlisted: true,
      matches: press.char('s'),
      run: () => openPane('sitemap'),
    },
    {
      key: 'd',
      label: 'denylist',
      unlisted: true,
      matches: press.char('d'),
      run: () => openPane('denylist'),
    },
  ];

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
        setWindowCursor((c) => moveWindowCursor(c, -1));
      else if (key.downArrow || input === 'j')
        setWindowCursor((c) => moveWindowCursor(c, 1));
      else if (key.return) chooseWindow();
      return;
    }
    if (focus === 'range-input') {
      if (key.escape) setFocus(pane ? 'pane' : 'editor');
      else if (key.return) submitRange(rangeInput);
      else if (key.backspace || key.delete)
        setRangeInput((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        const next = typeRange(rangeInput, input);
        setRangeInput(next);
        if (submitsOnPaste(input)) submitRange(next);
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
          onYes: () => setAsnError(denylist.stageDeny('asn', num) ?? ''),
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
            pickers.input,
            pickers.cursor,
            pickers.pickable.map(([ip]) => ip),
          ),
        );
      else if (key.upArrow)
        pickers.setCursor((c) => moveCursor(c, -1, pickers.pickable.length));
      else if (key.downArrow)
        pickers.setCursor((c) => moveCursor(c, 1, pickers.pickable.length));
      else if (key.backspace || key.delete) {
        pickers.setInput((s) => s.slice(0, -1));
        pickers.setCursor(-1);
      }
      // `w` cannot occur in an IP, so intercepting it here costs nothing and saves an esc.
      else if (input === 'w' || input === 'W') openWindowPick();
      // Same reasoning for `o`: no IP contains it (the filter strips non-hex anyway) and no JA4
      // digest does either, so filtering by it could only ever match nothing.
      else if (input === 'o' || input === 'O') submitAll();
      else if (input && !key.ctrl && !key.meta) {
        pickers.setCursor(-1); // typing re-asserts the typed text over any highlight
        const next = typeIdentity(pickers.kind, pickers.input, input);
        pickers.setInput(next);
        if (submitsOnPaste(input)) submitIp(next); // pasted with a trailing newline
      }
      return;
    }
    if (focus === 'pane') {
      if (!pane) {
        if (key.escape) setFocus('editor');
        return;
      }
      const p: Press = {
        input,
        return: key.return,
        escape: key.escape,
        tab: key.tab,
        shift: key.shift,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
      };
      bindingFor(paneBindings, pane, p)?.run(p);
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
      else if (input === 'v' || input === 'V') watch.toggle();
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
  // Both the footer and the handler read the same table, so a live key is always advertised.
  const paneHints: MaybeHint[] =
    focus === 'pane' && pane ? hintsFor(paneBindings, pane) : [];
  // The tab indicator shares the footer's first line, so its width counts toward the wrap.
  const tabNavWidth = showTabNav
    ? `◂ ${ipTabs.index + 1}/${ipTabs.tabs.length} ▸ tab/shift-tab · `.length
    : 0;
  const footerRows = paneFooter ? hintRows(paneHints, reportW, tabNavWidth) : 0;
  // Measured, not assumed: an IPv4 is 15 chars and a JA4 digest 36, so whether two columns fit
  // depends on what is actually listed. A row that wraps takes the whole Ink list with it, so
  // the quiet band stacks underneath when the width is not there.
  const { twoCol, rows: pickerRows } = pickerLayout(
    pickers.busiest.length,
    pickers.quiet.length,
    columnWidth(pickers.busiest, CAP_BUSIEST, isFlagged, isOpen, ROW_CHROME),
    columnWidth(pickers.quiet, CAP_QUIET, isFlagged, isOpen, ROW_CHROME),
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
    footerRows +
    (copied ? 1 : 0);
  return (
    <Box flexDirection="row">
      <Box
        flexDirection="column"
        width={rulesW}
        flexShrink={0}
        // At least full height so the footer below can be pushed to the bottom; a minimum, not a
        // fixed height, so a long rule list on a short terminal still grows rather than clipping.
        minHeight={reportH}
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
              pending={denylist.pending.get(it.rule.name)}
            />
          ))}
        </Box>
        {/* Absorbs the slack between the rule list and the footer, anchoring the footer to the
            bottom edge instead of floating under the last rule. */}
        <Box flexGrow={1} />
        {phase === 'select' && (
          <Box flexDirection="column">
            {applied && (
              <Text color={applied.ok ? 'green' : 'red'}>
                {applied.ok ? '✔' : '✖'} applied — {applied.summary} · keep
                editing, or q to quit
              </Text>
            )}
            <Text wrap="wrap">
              <FooterHints
                hints={[
                  { key: '↑/↓', label: 'move' },
                  { key: '←/→', label: 'action' },
                  { key: 'enter', label: 'menu' },
                  { key: 'space', label: 'on/off' },
                  { key: 'r', label: 'report' },
                  { key: 'i', label: 'ip' },
                  { key: 'f', label: 'ja4' },
                  { key: 's', label: 'sitemap' },
                  { key: 'd', label: 'denylist' },
                  { key: 't', label: 'watch-list' },
                  { key: 'g', label: 'ignore' },
                  {
                    key: 'v',
                    label: watch.on ? 'watch (on)' : 'watch',
                    active: watch.on,
                  },
                  ipTabs.tabs.length
                    ? { key: 'tab', label: 'cycle ips' }
                    : false,
                  { key: 'a', label: 'apply' },
                  { key: 'q', label: `quit (${onCount}/${items.length} on)` },
                ]}
              />
              {paneLoading ? <Text dimColor> (loading…)</Text> : null}
              {denylist.pending.size ? (
                <Text color="yellow">
                  {' '}
                  · {denylist.pending.size} rule(s) unapplied
                </Text>
              ) : null}
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
            <Text wrap="wrap">
              <FooterHints
                hints={[
                  { key: '↑/↓', label: 'choose' },
                  { key: 'enter', label: 'set' },
                  { key: 'esc', label: 'cancel' },
                  { key: 'q', label: 'quit' },
                ]}
              />
            </Text>
          </Box>
        )}
        {phase === 'applying' && (
          <Text color="yellow">applying… · q stops after the current rule</Text>
        )}
        <WatchStatus watch={watch} />
      </Box>
      {showPane && (
        <Box flexDirection="column" width={reportW}>
          <TabBar
            ipTabs={ipTabs}
            tabBar={tabBar}
            isLive={isLive}
            blink={blink}
          />
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
                denylist={denylist}
                lists={lists}
              />
            </Box>
          </Box>
          {copied && (
            // paneChrome reserves exactly one row for this note; a long save error must clip,
            // not wrap, or the frame outgrows the viewport.
            <Text
              wrap="truncate-end"
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
            <Box width={reportW}>
              {/* One wrapping flow so tab indicator and hints wrap together at the pane width,
                  and `footerRows` above reserves exactly the lines this produces. */}
              <Text wrap="wrap">
                {showTabNav && (
                  <>
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
                  </>
                )}
                {focus === 'pane' && <FooterHints hints={paneHints} />}
              </Text>
            </Box>
          )}
          {focus === 'window-pick' && (
            <WindowPicker cursor={windowCursor} presetIdx={presetIdx} />
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
              {asnError ? (
                <Text dimColor>{`  ${asnError}`}</Text>
              ) : (
                <Text>
                  {'  '}
                  <FooterHints
                    hints={[
                      { key: 'enter', label: 'confirm' },
                      { key: 'esc', label: 'cancel' },
                    ]}
                  />
                </Text>
              )}
            </Box>
          )}
          {focus === 'confirm' && confirm && (
            <ConfirmPrompt confirm={confirm} />
          )}
          {focus === 'ip-input' && (
            <IdentityPicker
              pickers={pickers}
              window={ipWindow}
              isLive={isLive}
              refreshSeconds={LIVE_REFRESH_MS / 1000}
              backingOff={failuresRef.current > 0}
              openAllMax={OPEN_ALL_MAX}
              twoCol={twoCol}
              row={pickerRow}
            />
          )}
        </Box>
      )}
    </Box>
  );
}
