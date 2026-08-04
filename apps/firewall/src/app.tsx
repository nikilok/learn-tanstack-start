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

import { fileURLToPath } from 'node:url';

import { actionColor, actionOptions, cycleAction, isLogOnly } from './actions';
import { type Advice, adviseBan } from './ban-advice';
import {
  ASN_DENY,
  JA4_DENY,
  valuesOf,
  withValue,
  withoutValue,
} from './deny-list';
import { type Activity, fetchDenyActivity } from './denylist-data';
import { type DenyEntry, denylistLines } from './denylist-view';
import { persistEnvVar } from './env-file';
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
import { resolveIpEntry } from './ip-entry';
import { type IpProfile, topIps, topJa4 } from './ip-profile';
import { profileLines } from './ip-profile-view';
import { type ReportData, fetchReport } from './report-data';
import { dryRun } from './rules';
import { type SitemapReport, fetchSitemapReport } from './sitemap-readers';
import { sitemapLines } from './sitemap-view';
import { type Window, resolveWindow, rollingWindow } from './time-window';
import { type IpTab, useIpTabs } from './use-ip-tabs';
import { type Pane, usePane } from './use-pane';
import { errMsg } from './util';

type PaneKind = 'report' | 'ip' | 'sitemap' | 'denylist';
const PANE_KEY: Record<string, PaneKind> = {
  r: 'report',
  i: 'ip',
  f: 'ip', // same pane, fingerprint picker
  s: 'sitemap',
  d: 'denylist',
};
const JA4_RULE = 'deny-scraper-ja4';
const ASN_RULE = 'deny-scraper-asn';
const DENY_ACTIVITY_HOURS = 144;
// Repo root, the single source of truth the denylist rules are rebuilt from on every apply.
const ENV_PATH = fileURLToPath(new URL('../../../.env.local', import.meta.url));
const IP_WINDOW_HOURS = 24;
const SITEMAP_WINDOW_HOURS = 144;
const TOP_IPS_LIMIT = 40; // fetched, so filtering still has material to work with
const IP_SUGGESTIONS = 8; // rows shown at once
const PANE_SHARE = 0.7; // the pane holds the data; the rules list is names and a tag
// Enough for the deny rule names in full plus a pending marker. At 34 the two deny rules both
// truncated to "deny-sc…", which is worse than useless when one of them has a staged change.
const MIN_RULES_W = 46;
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
  const [focus, setFocus] = useState<
    'editor' | 'pane' | 'ip-input' | 'asn-input' | 'range-input' | 'confirm'
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
  const [ipWindow, setIpWindow] = useState<Window>(() =>
    rollingWindow(IP_WINDOW_HOURS, new Date()),
  );
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const topIpList = usePane<[string, number][]>();
  const topJa4List = usePane<[string, number][]>();
  const denyActivity = usePane<Map<string, Activity>>();
  const [denyCursor, setDenyCursor] = useState(0);
  // Unbanned this session: the value is gone from the rule, so it needs its own record to stay
  // on screen as a pending change until applied.
  const [removedDenies, setRemovedDenies] = useState<string[]>([]);
  const [stagedDenies, setStagedDenies] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{
    prompt: string;
    detail: string;
    onYes: () => void;
  } | null>(null);
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
    // The rules are rebuilt from env on every apply, so a digest that lives only in the WAF is
    // un-banned by the next CI run. Write it back, or the ban quietly expires.
    let persisted = '';
    if (!anyError && (stagedDenies.length || removedDenies.length)) {
      try {
        const ja4 = snapshot.find((it) => it.rule.name === JA4_RULE);
        const asn = snapshot.find((it) => it.rule.name === ASN_RULE);
        if (ja4)
          persistEnvVar(
            ENV_PATH,
            'FW_BLOCKED_JA4',
            valuesOf(ja4.rule, JA4_DENY).join(','),
          );
        if (asn)
          persistEnvVar(
            ENV_PATH,
            'FW_BLOCKED_ASN',
            valuesOf(asn.rule, ASN_DENY).join(','),
          );
        setStagedDenies([]);
        setRemovedDenies([]);
        persisted = ' · denylist saved to .env.local';
      } catch (e) {
        persisted = ` · WARNING: applied but NOT saved to .env.local (${errMsg(e)}) — the next CI apply will undo it`;
      }
    }
    // Back to the editor, not a terminal screen — an apply is a step in a session.
    setApplied({ summary: summaryLine(statuses) + persisted, ok: !anyError });
    setPhase('select');
  };

  const creds = { projectId, teamId, token };

  const denyRuleOf = (name: string) => items.find((it) => it.rule.name === name);
  const liveJa4 = denyRuleOf(JA4_RULE)
    ? valuesOf((denyRuleOf(JA4_RULE) as Item).rule, JA4_DENY)
    : [];
  const liveAsn = denyRuleOf(ASN_RULE)
    ? valuesOf((denyRuleOf(ASN_RULE) as Item).rule, ASN_DENY)
    : [];
  const act = denyActivity.data;
  const denyEntries: DenyEntry[] = [
    ...liveJa4.map((v) => ({
      kind: 'ja4' as const,
      value: v,
      staged: stagedDenies.includes(v),
      removed: false,
      requests: act?.get(v)?.requests,
      denied: act?.get(v)?.denied,
    })),
    ...liveAsn.map((v) => ({
      kind: 'asn' as const,
      value: v,
      staged: stagedDenies.includes(v),
      removed: false,
      requests: act?.get(v)?.requests,
      denied: act?.get(v)?.denied,
    })),
    ...removedDenies.map((v) => ({
      kind: (v.includes('_') ? 'ja4' : 'asn') as 'ja4' | 'asn',
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
    const live = valuesOf(item.rule, spec);
    const added = stagedDenies.filter((v) => live.includes(v)).length;
    const dropped = removedDenies.filter((v) => !live.includes(v)).length;
    // Kept terse so it survives a narrow rules column; the footer and denylist pane carry detail.
    const parts = [added ? `+${added}` : '', dropped ? `−${dropped}` : ''].filter(
      Boolean,
    );
    if (parts.length) pendingByRule.set(ruleName, parts.join(' '));
  }

  const ipAdvice = ipTabs.active?.data
    ? adviseBan({
        total: ipTabs.active.data.total,
        mix: ipTabs.active.data.mix,
        shape: ipTabs.active.data.shape,
        ja4: ipTabs.active.data.byJa4,
        asns: ipTabs.active.data.byAsn,
        botVerified: ipTabs.active.data.byBotVerified,
        wafActions: ipTabs.active.data.byWafAction,
        wafRules: ipTabs.active.data.byWafRule,
        statuses: ipTabs.active.data.byStatus,
        digestReach: ipTabs.active.data.digestReach,
        asnReach: ipTabs.active.data.asnReach,
        // Live-and-applied, NOT merely present in the rule: a staged digest is in the local
        // rule but has not been written, and calling that "already denied" is a lie.
        alreadyDeniedJa4:
          liveJa4.includes(subjectDigest) && !stagedDenies.includes(subjectDigest),
        stagedJa4: stagedDenies.includes(subjectDigest),
        // AS numbers cannot be derived from the name observability reports, so an ASN already
        // in FW_BLOCKED_ASN is caught at staging (the number is typed there), not here.
        alreadyDeniedAsn: false,
        windowMinutes: ipTabs.active.data.windowHours * 60,
      })
    : undefined;

  // Substring, not prefix: an IP is often recognised by its tail as much as its network part.
  const pickList = pickKind === 'ip' ? topIpList : topJa4List;
  const ipFiltered = (pickList.data ?? []).filter(
    ([ip]) => !ipInput || ip.includes(ipInput),
  );
  const ipMatches = ipFiltered.slice(0, IP_SUGGESTIONS);

  /** Open a pane, loading it on first view. `i` always prompts for another IP — tab is how you get back to one already open. */
  const openPane = (kind: PaneKind, pick: 'ip' | 'ja4' = 'ip') => {
    setPane(kind);
    setReportScroll(0);
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
    if (kind === 'sitemap' && !sitemap.data)
      void sitemap.load(() => fetchSitemapReport(creds, SITEMAP_WINDOW_HOURS));
    if (kind === 'denylist' && !denyActivity.data)
      void denyActivity.load(async () => {
        const { activity, error } = await fetchDenyActivity(
          creds,
          DENY_ACTIVITY_HOURS,
          liveJa4,
        );
        if (error && !activity.size) throw new Error(error);
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
    setRemovedDenies((s) => [...new Set([...s, entry.value])]);
    setApplied(null);
  };

  /** Load the picker list for `kind`. Cached per kind so switching back is instant. */
  const loadPickList = (kind: 'ip' | 'ja4', w: Window) => {
    const cache = kind === 'ip' ? topIpList : topJa4List;
    if (cache.data) return;
    void cache.load(async () => {
      const { rows, error } =
        kind === 'ip'
          ? await topIps(creds, w, TOP_IPS_LIMIT)
          : await topJa4(creds, w, TOP_IPS_LIMIT);
      if (error) throw new Error(error);
      return rows;
    });
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
    setRangeError('');
    setIpWindow(next.window);
    // The list is window-scoped, so it has to be refetched, not filtered.
    void topIpList.load(async () => {
      const { rows, error } = await topIps(creds, next.window, TOP_IPS_LIMIT);
      if (error) throw new Error(error);
      return rows;
    });
    // Back to the picker: choosing a range is a step in choosing an IP, not the end of it.
    setIpInput('');
    setIpCursor(-1);
    setFocus('ip-input');
  };

  /** Re-query whatever is on screen, so a pane is never stuck on a stale answer. */
  const refreshPane = () => {
    if (pane === 'report') void report.load(() => fetchReport(creds));
    else if (pane === 'sitemap')
      void sitemap.load(() => fetchSitemapReport(creds, SITEMAP_WINDOW_HOURS));
    else if (pane === 'ip') ipTabs.refresh();
    else if (pane === 'denylist')
      void denyActivity.load(async () => {
        const { activity } = await fetchDenyActivity(
          creds,
          DENY_ACTIVITY_HOURS,
          liveJa4,
        );
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
      setIpError(
        pickKind === 'ip' ? 'not an IP address' : 'not a JA4 digest',
      );
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
    if (focus === 'range-input') {
      if (key.escape) setFocus(pane ? 'pane' : 'editor');
      else if (key.return) submitRange(rangeInput);
      else if (key.backspace || key.delete)
        setRangeInput((s) => s.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        // Filter within the chunk and submit on an embedded newline: a pasted range arrives
        // whole, and testing the whole string would reject every paste.
        const next = (rangeInput + input.replace(/[^\d\s/.-]/g, '')).slice(0, 32);
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
        if (!/^[1-9]\d{0,9}$/.test(num)) {
          setAsnError('AS number must be a positive integer');
          return;
        }
        setAsnError('');
        setConfirm({
          prompt: `Deny the whole network AS${num} (${lever?.value ?? ''})?`,
          detail:
            'an ASN deny hits EVERY client on that network — cleared only because none of it ever fetched a sub-resource',
          onYes: () => stageDeny('asn', num),
        });
        setFocus('confirm');
      } else if (key.backspace || key.delete) setAsnInput((s) => s.slice(0, -1));
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
            ipMatches.map(([ip]) => ip),
          ),
        );
      else if (key.upArrow) setIpCursor((c) => Math.max(-1, c - 1));
      else if (key.downArrow)
        setIpCursor((c) => Math.min(ipMatches.length - 1, c + 1));
      else if (key.backspace || key.delete) {
        setIpInput((s) => s.slice(0, -1));
        setIpCursor(-1);
      }
      // `w` cannot occur in an IP, so intercepting it here costs nothing and saves an esc.
      else if (input === 'w') {
        setRangeInput('');
        setRangeError('');
        setFocus('range-input');
      } else if (input && !key.ctrl && !key.meta) {
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
      } else if (input === 'u' && pane === 'denylist') {
        const entry = denyEntries[denyCursor];
        if (!entry || entry.removed) return;
        setConfirm({
          prompt: `Lift the deny on ${entry.value}?`,
          detail: `${entry.kind.toUpperCase()} · takes effect on apply`,
          onYes: () => unstageDeny(entry),
        });
        setFocus('confirm');
      } else if (input === 'x' && pane === 'ip') {
        ipTabs.close();
        setReportScroll(0);
      } else if (PANE_KEY[input])
        openPane(PANE_KEY[input], input === 'f' ? 'ja4' : 'ip');
      else if (key.escape) setFocus('editor');
      else if (pane === 'denylist' && (key.upArrow || input === 'k'))
        setDenyCursor((c) => Math.max(0, c - 1));
      else if (pane === 'denylist' && (key.downArrow || input === 'j'))
        setDenyCursor((c) => Math.min(denyEntries.length - 1, c + 1));
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
      else if (PANE_KEY[input])
        openPane(PANE_KEY[input], input === 'f' ? 'ja4' : 'ip');
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
    // The suggestion overlay grows the prompt, so the box has to give back the same rows.
    (focus === 'ip-input' ? 3 + ipMatches.length : 0) +
    (focus === 'confirm' ? 3 : 0) +
    (focus === 'asn-input' ? 1 : 0) +
    (focus === 'range-input' ? 1 : 0) +
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
              ip · f ja4 · s sitemap · d denylist
              {ipTabs.tabs.length ? ' · tab cycle ips' : ''}
              {paneLoading ? ' (loading…)' : ''} · a apply · q quit ({onCount}/
              {items.length} on)
              {pendingByRule.size ? (
                <Text color="yellow"> · {pendingByRule.size} rule(s) unapplied</Text>
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
      </Box>
      {pane && (
        <Box flexDirection="column" width={reportW}>
          {pane === 'ip' && ipTabs.tabs.length > 0 && (
            <Box>
              {ipTabs.tabs.map((t, i) => (
                <Text
                  key={`${t.subject.kind}:${t.subject.value}`}
                  bold={i === ipTabs.index}
                  color={i === ipTabs.index ? 'cyan' : undefined}
                  dimColor={i !== ipTabs.index}
                >
                  {/* Digests are long, so tabs show a recognisable head, never the whole thing. */}
                  {i === ipTabs.index
                    ? `[${tabLabel(t)}]`
                    : ` ${tabLabel(t)} `}
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
                advice={ipAdvice}
                denyEntries={denyEntries}
                denyCursor={denyCursor}
                denyActivity={denyActivity}
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
                  j/k {pane === 'denylist' ? 'select' : 'scroll'} · R refresh · i
                  new ip · f ja4 · w range
                  {/* Shown exactly when `b` does something: the advisor offered a lever. */}
                  {pane === 'ip' && ipAdvice?.lever
                    ? ` · b deny ${ipAdvice.lever.kind === 'ja4' ? 'fingerprint' : 'network'}`
                    : ''}
                  {pane === 'denylist' ? ' · u unban' : ''}
                  {pane === 'ip' ? ' · x close tab' : ''} · esc rules
                </Text>
              )}
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
                      : `top ${ipMatches.length} of ${pickList.data.length}, type to filter · w changes range`}
                  </Text>
                )
              )}
              {ipMatches.map(([ip, count], i) => {
                const open = ipTabs.tabs.some(
                  (t) => t.subject.value === ip,
                );
                return (
                  <Box key={ip}>
                    <Text color="cyan">{i === ipCursor ? '▶ ' : '  '}</Text>
                    <Text dimColor>{String(count).padStart(7)} </Text>
                    <Text bold={i === ipCursor} color={i === ipCursor ? 'cyan' : undefined}>
                      {ip}
                    </Text>
                    {open && <Text dimColor> (open)</Text>}
                  </Box>
                );
              })}
              {Boolean(topIpList.data) && !ipMatches.length && ipInput && (
                <Text dimColor>  no busy IP matches — enter profiles it anyway</Text>
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
  denyEntries,
  denyCursor,
  denyActivity,
}: {
  kind: PaneKind;
  width: number;
  report: Pane<ReportData>;
  ipTab: IpTab | undefined;
  sitemap: Pane<SitemapReport>;
  advice: Advice | undefined;
  denyEntries: DenyEntry[];
  denyCursor: number;
  denyActivity: Pane<Map<string, Activity>>;
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
            error: denyActivity.error || undefined,
          },
          denyCursor,
        )}
        width={width}
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
            ? profileLines((ipTab as IpTab).data as IpProfile, width, advice)
            : sitemapLines(sitemap.data as SitemapReport)
        }
        width={width}
      />
    </Box>
  );
}
