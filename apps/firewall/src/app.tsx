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
import { Lines } from './components/lines';
import { ReportView } from './components/report-view';
import { type Phase, Row, summaryLine } from './components/rule-list';
import type { IpProfile } from './ip-profile';
import { profileLines } from './ip-profile-view';
import { type ReportData, fetchReport } from './report-data';
import { dryRun } from './rules';
import { type SitemapReport, fetchSitemapReport } from './sitemap-readers';
import { sitemapLines } from './sitemap-view';
import { type IpTab, useIpTabs } from './use-ip-tabs';
import { type Pane, usePane } from './use-pane';
import { errMsg } from './util';

type PaneKind = 'report' | 'ip' | 'sitemap';
const PANE_KEY: Record<string, PaneKind> = {
  r: 'report',
  i: 'ip',
  s: 'sitemap',
};
const IP_WINDOW_HOURS = 24;
const SITEMAP_WINDOW_HOURS = 144;
const PANE_SHARE = 0.7; // the pane holds the data; the rules list is names and a tag
const MIN_RULES_W = 34; // enough for a truncated name plus its action tag
const PANE_GAP = 2; // marginRight between the two columns
const IP_CHARS = /^[0-9a-fA-F.:]+$/; // everything an IPv4/IPv6 literal can contain

/** Interactive firewall manager: toggle each rule on/off and switch its action (log/challenge/deny/bypass), view the report in a side pane, then apply (upsert) to Vercel. */
export function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [menuCursor, setMenuCursor] = useState(0);
  const [idByName, setIdByName] = useState<Map<string, string>>(new Map());
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
  const [focus, setFocus] = useState<'editor' | 'pane' | 'ip-input'>('editor');
  const [ipInput, setIpInput] = useState('');
  const [ipError, setIpError] = useState('');
  const applying = useRef(false); // re-entrancy guard: 'a' fires before the phase re-render lands
  // Quit requested mid-apply: exit() only unmounts, so the loop must stop itself first.
  const cancelApply = useRef(false);
  const [reportScroll, setReportScroll] = useState(0);
  const [reportMaxScroll, setReportMaxScroll] = useState(0);
  const reportRef = useRef<DOMElement | null>(null);

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
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: res.status, detail: res.detail } : it,
          ),
        );
      } catch (e) {
        anyError = true;
        statuses.push('error');
        const detail = errMsg(e);
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: 'error', detail } : it,
          ),
        );
      }
    }
    // Set both ways: a retry that succeeds after a failed apply must not still exit non-zero.
    process.exitCode = anyError ? 1 : 0;
    applying.current = false;
    if (cancelled) {
      exit(); // deferred to here so no write is still in flight
      return;
    }
    // Back to the editor, not a terminal screen — an apply is a step in a session.
    setApplied({ summary: summaryLine(statuses), ok: !anyError });
    setPhase('select');
  };

  const creds = { projectId, teamId, token };

  /** Open a pane, loading it on first view. `i` always prompts for another IP — tab is how you get back to one already open. */
  const openPane = (kind: PaneKind) => {
    setPane(kind);
    setReportScroll(0);
    if (kind === 'ip') {
      setIpInput('');
      setIpError('');
      setFocus('ip-input');
      return;
    }
    setFocus('pane');
    if (kind === 'report' && !report.data)
      void report.load(() => fetchReport(creds));
    if (kind === 'sitemap' && !sitemap.data)
      void sitemap.load(() => fetchSitemapReport(creds, SITEMAP_WINDOW_HOURS));
  };

  /** Tab from elsewhere surfaces the IP tabs at the one you were last on; only a second press moves. Advancing straight away would skip a tab you had not seen yet. */
  const gotoIpTabs = (dir: 1 | -1) => {
    setReportScroll(0);
    setFocus('pane');
    if (pane === 'ip') ipTabs.cycle(dir);
    else setPane('ip');
  };

  /** Re-query whatever is on screen, so a pane is never stuck on a stale answer. */
  const refreshPane = () => {
    if (pane === 'report') void report.load(() => fetchReport(creds));
    else if (pane === 'sitemap')
      void sitemap.load(() => fetchSitemapReport(creds, SITEMAP_WINDOW_HOURS));
    else if (pane === 'ip') ipTabs.refresh();
  };

  /** Open `value` as a tab; keeps focus in the field when it is not an IP. Takes the value rather than reading state, so a paste that ends in a newline can submit what it just appended. */
  const submitIp = (value: string) => {
    const ip = value.trim();
    if (!ip || !IP_CHARS.test(ip)) {
      setIpError('not an IP address');
      return;
    }
    setIpError('');
    setFocus('pane');
    setReportScroll(0);
    ipTabs.open(ip, IP_WINDOW_HOURS);
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
    // Text entry owns every keystroke, so q/j/k stay typeable inside an IP.
    if (focus === 'ip-input') {
      if (key.escape) setFocus(ipTabs.tabs.length ? 'pane' : 'editor');
      else if (key.return) submitIp(ipInput);
      else if (key.backspace || key.delete) setIpInput((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        // A paste arrives as ONE chunk, so filter within it rather than testing the whole
        // string — requiring the chunk to match meant pasting an IP silently did nothing.
        const next = (ipInput + input.replace(/[^0-9a-fA-F.:]/g, '')).slice(
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
      else if (input === 'x' && pane === 'ip') {
        ipTabs.close();
        setReportScroll(0);
      } else if (PANE_KEY[input]) openPane(PANE_KEY[input]);
      else if (key.escape) setFocus('editor');
      else if (key.upArrow || input === 'k')
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
      else if (PANE_KEY[input]) openPane(PANE_KEY[input]);
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
  const reportW = Math.max(
    46,
    Math.min(cols - MIN_RULES_W - PANE_GAP, Math.floor(cols * PANE_SHARE)),
  );
  const rulesW = pane ? cols - reportW - PANE_GAP : cols;
  const longestName = items.reduce((n, it) => Math.max(n, it.rule.name.length), 0);
  // ◂ n/m ▸ stays visible whenever there is somewhere to cycle to, even with the rules focused —
  // otherwise nothing on screen says the other lookups are still open.
  const showTabNav = pane === 'ip' && ipTabs.tabs.length > 1;
  const paneFooter = showTabNav || focus === 'pane';
  // Rows the pane spends on its own tab bar / prompt / footer, so the bordered box stays inside the
  // viewport — an over-tall frame makes the terminal scroll and hides the editor cursor.
  const paneChrome =
    (pane === 'ip' && ipTabs.tabs.length ? 1 : 0) +
    (focus === 'ip-input' ? 2 : 0) +
    (paneFooter ? 1 : 0);
  return (
    <Box flexDirection="row">
      <Box
        flexDirection="column"
        width={rulesW}
        flexShrink={0}
        marginRight={pane ? PANE_GAP : 0}
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
              ip · s sitemap
              {ipTabs.tabs.length ? ' · tab cycle ips' : ''}
              {paneLoading ? ' (loading…)' : ''} · a apply · q quit ({onCount}/
              {items.length} on)
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
      </Box>
      {pane && (
        <Box flexDirection="column" width={reportW}>
          {pane === 'ip' && ipTabs.tabs.length > 0 && (
            <Box>
              {ipTabs.tabs.map((t, i) => (
                <Text
                  key={t.ip}
                  bold={i === ipTabs.index}
                  color={i === ipTabs.index ? 'cyan' : undefined}
                  dimColor={i !== ipTabs.index}
                >
                  {i === ipTabs.index ? `[${t.ip}]` : ` ${t.ip} `}
                  {t.loading ? '…' : ''}{' '}
                </Text>
              ))}
            </Box>
          )}
          <Box
            flexDirection="column"
            height={reportH - paneChrome}
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
              />
            </Box>
          </Box>
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
                  j/k scroll · R refresh · i new ip
                  {pane === 'ip' ? ' · x close tab' : ''} · esc rules
                </Text>
              )}
            </Box>
          )}
          {focus === 'ip-input' && (
            <Box>
              <Text color="cyan">IP: </Text>
              <Text>{ipInput}</Text>
              <Text color="cyan">▏</Text>
              <Text dimColor>
                {ipError ? `  ${ipError}` : '  enter profile · esc cancel'}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/** Body of whichever side pane is open. Report keeps its bespoke Ink view; the other two share the line model. */
function PaneBody({
  kind,
  width,
  report,
  ipTab,
  sitemap,
}: {
  kind: PaneKind;
  width: number;
  report: Pane<ReportData>;
  ipTab: IpTab | undefined;
  sitemap: Pane<SitemapReport>;
}) {
  if (kind === 'report')
    return (
      <ReportView
        report={report.data}
        error={report.error}
        loading={report.loading}
      />
    );
  const what = kind === 'ip' ? 'IP profile' : 'sitemap readers';
  const state = kind === 'ip' ? ipTab : sitemap;
  if (!state)
    return <Text dimColor>no {what} yet — i to look one up</Text>;
  if (state.error) return <Text color="red">{state.error}</Text>;
  if (!state.data)
    return (
      <Text dimColor>{state.loading ? `Loading ${what}…` : `no ${what} yet`}</Text>
    );
  return (
    <Box flexDirection="column">
      {state.loading && <Text dimColor>refreshing…</Text>}
      <Lines
        lines={
          kind === 'ip'
            ? profileLines((ipTab as IpTab).data as IpProfile, width)
            : sitemapLines(sitemap.data as SitemapReport)
        }
        width={width}
      />
    </Box>
  );
}
