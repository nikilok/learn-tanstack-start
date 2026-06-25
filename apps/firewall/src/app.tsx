// The interactive rule-manager TUI: a stateful Ink container wiring the data layer
// (client.ts) to the presentational components (components.tsx) and the report (report-data.ts).

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
  type Item,
  applyItem,
  fetchLive,
  projectId,
  seedItems,
  teamId,
  token,
} from './client';
import { type Phase, ReportView, Row, summaryLine } from './components';
import { type ReportData, fetchReport } from './report-data';
import { dryRun } from './rules';
import { errMsg } from './util';

/** Interactive firewall manager: toggle each rule on/off and switch its action (log/challenge/deny/bypass), view the report in a side pane, then apply (upsert) to Vercel. */
export function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [menuCursor, setMenuCursor] = useState(0);
  const [idByName, setIdByName] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [report, setReport] = useState<ReportData | null>(null);
  const [reportError, setReportError] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false); // report pane visible on the right
  const [focus, setFocus] = useState<'editor' | 'report'>('editor');
  const applying = useRef(false); // re-entrancy guard: 'a' fires before the phase re-render lands
  const loadingReport = useRef(false); // dedupe concurrent report fetches
  const [reportScroll, setReportScroll] = useState(0);
  const [reportMaxScroll, setReportMaxScroll] = useState(0);
  const reportRef = useRef<DOMElement | null>(null);

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

  // Measure the report content (post-render) to clamp how far it can scroll: content height minus
  // the visible area (reportH minus the box's top+bottom border).
  useEffect(() => {
    if (!reportOpen || !report || !reportRef.current) return;
    const max = Math.max(
      0,
      measureElement(reportRef.current).height - (reportH - 2),
    );
    setReportMaxScroll(max);
    setReportScroll((s) => Math.min(s, max));
  }, [report, reportOpen, reportH]);

  /** Sequentially upsert each rule with its chosen active + action, updating per-row status; refreshes ids first so a dashboard edit since load can't target a stale id; sets a non-zero exit code on any failure. */
  const applyAll = async (snapshot: Item[]) => {
    let ids = idByName;
    try {
      ids = (await fetchLive()).idByName;
    } catch {
      // keep the mount snapshot if the refresh fails — better than aborting the apply.
    }
    let anyError = false;
    for (let i = 0; i < snapshot.length; i++) {
      setItems((prev) =>
        prev.map((it, j) => (j === i ? { ...it, status: 'applying' } : it)),
      );
      try {
        const res = await applyItem(snapshot[i], ids);
        if (res.status === 'error') anyError = true; // a returned (not thrown) error must still fail the run
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: res.status, detail: res.detail } : it,
          ),
        );
      } catch (e) {
        anyError = true;
        const detail = errMsg(e);
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: 'error', detail } : it,
          ),
        );
      }
    }
    if (anyError) process.exitCode = 1;
    setPhase('done');
  };

  /** Fetch the firewall report for the side pane; dedupes concurrent loads and keeps the prior result visible while refreshing. */
  const loadReport = async () => {
    if (loadingReport.current) return;
    loadingReport.current = true;
    setReportLoading(true);
    setReportError('');
    setReportScroll(0);
    try {
      setReport(await fetchReport({ projectId, teamId, token }));
    } catch (e) {
      setReportError(errMsg(e));
    } finally {
      loadingReport.current = false;
      setReportLoading(false);
    }
  };

  /** Cycle the highlighted rule's action in the given direction. */
  const cycleCursorAction = (dir: 1 | -1) =>
    setItems((prev) =>
      prev.map((it, j) =>
        j === cursor
          ? { ...it, action: cycleAction(it.rule, it.action, dir) }
          : it,
      ),
    );

  useInput((input, key) => {
    if (focus === 'report') {
      if (input === 'q') exit();
      else if (input === 'r')
        void loadReport(); // refresh
      else if (key.escape) setFocus('editor');
      else if (key.upArrow || input === 'k')
        setReportScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === 'j')
        setReportScroll((s) => Math.min(reportMaxScroll, s + 1));
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
        setItems((prev) =>
          prev.map((it, j) =>
            j === cursor ? { ...it, active: !it.active } : it,
          ),
        );
      else if (input === 'r') {
        setReportOpen(true);
        setFocus('report');
        if (!report) void loadReport(); // lazy: fetch once; cached after, so re-opening is instant
      } else if (input === 'a') {
        if (applying.current) return;
        applying.current = true;
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
        setItems((prev) =>
          prev.map((it, j) => (j === cursor ? { ...it, action: chosen } : it)),
        );
        setPhase('select');
      } else if (key.escape || key.leftArrow) setPhase('select');
      else if (input === 'q') exit();
    } else if (phase === 'done' || phase === 'fatal') {
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
  const reportW = Math.max(46, Math.floor(cols * 0.5)); // ≥50% on wide terminals; 46-col floor keeps it readable when narrow
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" flexGrow={1} marginRight={reportOpen ? 2 : 0}>
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
            />
          ))}
        </Box>
        {phase === 'select' && (
          <Text dimColor>
            ↑/↓ move · ←/→ action · enter menu · space on/off · r report
            {reportLoading ? ' (loading…)' : ''} · a apply · q quit ({onCount}/
            {items.length} on)
          </Text>
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
        {phase === 'applying' && <Text color="yellow">applying…</Text>}
        {phase === 'done' && (
          <Box flexDirection="column">
            <Text color="green">Done — {summaryLine(items)}.</Text>
            <Text dimColor>q to quit</Text>
          </Box>
        )}
      </Box>
      {reportOpen && (
        <Box
          flexDirection="column"
          width={reportW}
          height={reportH}
          borderStyle="round"
          borderColor={focus === 'report' ? 'cyan' : 'gray'}
          paddingX={1}
          overflowY="hidden"
        >
          <Box
            ref={reportRef}
            flexDirection="column"
            flexShrink={0}
            marginTop={-reportScroll}
          >
            <ReportView
              report={report}
              error={reportError}
              loading={reportLoading}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
