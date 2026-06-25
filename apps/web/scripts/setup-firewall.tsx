import { readFileSync } from 'node:fs';

import { Vercel } from '@vercel/sdk';
import { Box, Text, render, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

type RateLimitAction = 'log' | 'challenge' | 'deny'; // rateLimit exceeded-action — bypass is NOT valid here
type ActionChoice = 'log' | 'challenge' | 'deny' | 'bypass'; // a rule's switchable mitigate action
type Condition = {
  type: 'path' | 'query' | 'header';
  op: 'pre' | 'eq' | 'ex' | 'sub' | 're';
  key?: string;
  value?: string | string[];
  neg?: boolean;
};
type Rule = {
  name: string;
  description: string;
  active: boolean;
  conditionGroup: { conditions: Condition[] }[];
  action: {
    mitigate: {
      action: 'rate_limit' | ActionChoice;
      rateLimit?: {
        algo: 'fixed_window';
        window: number;
        limit: number;
        keys: string[];
        action: RateLimitAction;
      };
      actionDuration?: string;
    };
  };
};

// Phase 1 = observe: every rule logs only, nothing is blocked. Flip individual rules to challenge/deny/bypass in the TUI (or below) and apply.
const OBSERVE: RateLimitAction = 'log';
const dryRun =
  process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

/** Read a positive-integer ceiling from the env (FW_*_LIMIT) — kept in .env.local, never the repo, so public code doesn't reveal the thresholds. Returns a placeholder in dry-run, which only lists rule names. */
function envLimit(name: string): number {
  const v = Number(process.env[name]);
  if (Number.isInteger(v) && v > 0) return v;
  if (dryRun) return 0; // dry-run lists rule names only; real ceilings not needed
  throw new Error(
    `${name} must be a positive integer (set it in .env.local) — firewall ceilings are kept out of the repo`,
  );
}

const SERVERFN_LIMIT = envLimit('FW_SERVERFN_LIMIT');
const SEARCH_LIMIT = envLimit('FW_SEARCH_LIMIT');
const TILES_LIMIT = envLimit('FW_TILES_LIMIT');
const JA4_LIMIT = envLimit('FW_JA4_LIMIT');

/** Build a per-key fixed-window (60s) rate-limit rule, observe-mode unless `action` overrides it. */
function rateLimitRule(opts: {
  name: string;
  description: string;
  conditions: Condition[];
  limit: number;
  keys: string[];
  actionDuration: string;
  action?: RateLimitAction;
}): Rule {
  return {
    name: opts.name,
    description: opts.description,
    active: true,
    conditionGroup: [{ conditions: opts.conditions }],
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit: opts.limit,
          keys: opts.keys,
          action: opts.action ?? OBSERVE,
        },
        actionDuration: opts.actionDuration,
      },
    },
  };
}

/** Custom WAF rules scoped to SponsorSearch's real expensive paths (search RPC, SSR search, tile proxy) — complements the managed Bot Protection ruleset. Googlebot doesn't hit these paths, so SEO is untouched. Limits are observe-mode starting points; calibrate from Firewall → Traffic before enforcing. */
const rules: Rule[] = [
  rateLimitRule({
    name: 'rl-serverfn-ip',
    description:
      'Per-IP rate limit on server-fn RPCs (searchHmrc + detail lookups). Phase 1: log.',
    conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }],
    limit: SERVERFN_LIMIT,
    keys: ['ip'],
    actionDuration: '1h',
  }),
  rateLimitRule({
    name: 'rl-ssr-search-ip',
    description:
      'Per-IP rate limit on SSR search enumeration (/?search=). Phase 1: log.',
    conditions: [
      { type: 'path', op: 'eq', value: '/' },
      { type: 'query', op: 'ex', key: 'search' },
    ],
    limit: SEARCH_LIMIT,
    keys: ['ip'],
    actionDuration: '1h',
  }),
  rateLimitRule({
    name: 'rl-tiles-ip',
    description:
      'Per-IP rate limit on the Stadia tile proxy (bursts on pan/zoom, so high). Phase 1: log.',
    conditions: [{ type: 'path', op: 'pre', value: '/api/tiles' }],
    limit: TILES_LIMIT,
    keys: ['ip'],
    actionDuration: '15m',
  }),
  {
    name: 'tile-hotlink',
    description:
      'Off-site tile hotlinking (Referer present and not our host). Phase 1: log; Phase 2: deny.',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'pre', value: '/api/tiles' },
          { type: 'header', op: 'ex', key: 'referer' },
          {
            type: 'header',
            op: 're',
            key: 'referer',
            // Host-anchored: sponsorsearch.co.uk + subdomains pass; sponsorsearch.co.uk.evil.com does NOT (substring match would let it through).
            value:
              '^https?://([a-z0-9-]+\\.)*sponsorsearch\\.co\\.uk([/:?#].*)?$',
            neg: true,
          },
        ],
      },
    ],
    action: { mitigate: { action: OBSERVE } },
  },
  rateLimitRule({
    name: 'observe-ja4-serverfn',
    description:
      'Observe per-JA4 volume on server-fn RPCs — surfaces a distributed scraper using one TLS fingerprint across many IPs that per-IP rules miss. LOG ONLY: browser JA4s are shared by millions of real users, so never flip this to enforce.',
    conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }],
    limit: JA4_LIMIT,
    keys: ['ja4_digest'],
    actionDuration: '1h',
    action: 'log', // never deny/challenge — would nuke real browsers sharing a JA4
  }),
];

/** Resolve Vercel project credentials from env (preferred) or the linked `.vercel/project.json`; throws if project/team/token are missing. Returns plain `string`s so callers see non-undefined types. */
function resolveCredentials(): {
  projectId: string;
  teamId: string;
  bearerToken: string;
} {
  let link: { projectId?: string; orgId?: string } = {};
  try {
    link = JSON.parse(
      readFileSync(new URL('../.vercel/project.json', import.meta.url), 'utf8'),
    );
  } catch {
    // .vercel/project.json is gitignored / absent on fresh clones & CI — fall back to env.
  }
  const projectId = process.env.VERCEL_PROJECT_ID ?? link.projectId;
  const teamId = process.env.VERCEL_TEAM_ID ?? link.orgId;
  const bearerToken = process.env.VERCEL_TOKEN;
  if (!projectId || !teamId) {
    throw new Error(
      'projectId/teamId not found — run `vercel link` or set VERCEL_PROJECT_ID + VERCEL_TEAM_ID',
    );
  }
  if (!bearerToken) {
    throw new Error(
      'VERCEL_TOKEN not set — create one at https://vercel.com/account/tokens',
    );
  }
  return { projectId, teamId, bearerToken };
}

const { projectId, teamId, bearerToken } = resolveCredentials();
const vercel = new Vercel({ bearerToken });

const ACTIONS: ActionChoice[] = ['log', 'challenge', 'deny', 'bypass'];

/** Coerce an arbitrary action string to one of the four switchable choices, else undefined. */
function asChoice(a: string | null | undefined): ActionChoice | undefined {
  return ACTIONS.includes(a as ActionChoice) ? (a as ActionChoice) : undefined;
}

/** The action that actually governs a rule: a rate-limit rule's exceeded-action, else the mitigate action. Works on both our rules and the SDK's live shape. */
function effectiveAction(m: {
  action: string;
  rateLimit?: { action?: string | null } | null;
}): string | undefined {
  return m.action === 'rate_limit'
    ? (m.rateLimit?.action ?? undefined)
    : m.action;
}

/** Switchable actions valid for a rule: rate-limit rules can't bypass (the exceeded-action enum excludes it). */
function actionOptions(rule: Rule): ActionChoice[] {
  return rule.action.mitigate.action === 'rate_limit'
    ? ['log', 'challenge', 'deny']
    : ['log', 'challenge', 'deny', 'bypass'];
}

/** Copy of the rule with its governing action set: rate-limit rules update rateLimit.action, others mitigate.action. */
function withAction(rule: Rule, action: ActionChoice): Rule {
  const m = rule.action.mitigate;
  if (m.action === 'rate_limit' && m.rateLimit) {
    // actionOptions() never offers bypass for rate-limit rules, so action is log/challenge/deny here.
    return {
      ...rule,
      action: {
        mitigate: {
          ...m,
          rateLimit: { ...m.rateLimit, action: action as RateLimitAction },
        },
      },
    };
  }
  return { ...rule, action: { mitigate: { ...m, action } } };
}

/** Ink colour for an action tag — red deny, yellow challenge, cyan bypass, dim log. */
function actionColor(a: ActionChoice): string {
  return a === 'deny'
    ? 'red'
    : a === 'challenge'
      ? 'yellow'
      : a === 'bypass'
        ? 'cyan'
        : 'gray';
}

type ApplyStatus = 'idle' | 'applying' | 'inserted' | 'overwrote' | 'error';
type LiveConfig = {
  idByName: Map<string, string>;
  activeByName: Map<string, boolean>;
  actionByName: Map<string, ActionChoice>;
};

/** Fetch the active firewall config and index our rules' current id + active state + governing action by name. */
async function fetchLive(): Promise<LiveConfig> {
  const config = await vercel.security.getFirewallConfig({
    projectId,
    teamId,
    configVersion: 'active',
  });
  const idByName = new Map<string, string>();
  const activeByName = new Map<string, boolean>();
  const actionByName = new Map<string, ActionChoice>();
  for (const r of config.rules ?? []) {
    idByName.set(r.name, r.id);
    activeByName.set(r.name, r.active);
    const m = r.action.mitigate;
    const c = m ? asChoice(effectiveAction(m)) : undefined;
    if (c) actionByName.set(r.name, c);
  }
  return { idByName, activeByName, actionByName };
}

/** Upsert one rule (insert if new, overwrite if it already exists), honouring dry-run. Returns the outcome for display. */
async function applyRule(
  rule: Rule,
  idByName: Map<string, string>,
): Promise<{ status: ApplyStatus; detail?: string }> {
  const id = idByName.get(rule.name);
  if (dryRun)
    return { status: id ? 'overwrote' : 'inserted', detail: 'dry-run' };
  if (id) {
    await vercel.security.updateFirewallConfig({
      projectId,
      teamId,
      requestBody: { action: 'rules.update', id, value: rule },
    });
    return { status: 'overwrote' };
  }
  await vercel.security.updateFirewallConfig({
    projectId,
    teamId,
    requestBody: { action: 'rules.insert', value: rule },
  });
  return { status: 'inserted' };
}

/** Non-interactive apply (CI / piped, no TTY): upsert every rule with its code-defined active + action. Mirrors the old script. */
async function runHeadless() {
  const { idByName } = await fetchLive();
  for (const rule of rules) {
    const { status, detail } = await applyRule(rule, idByName);
    console.log(`${status}${detail ? ` (${detail})` : ''}  ${rule.name}`);
  }
  console.log(
    '\nApplied. Watch Firewall → Traffic, then set Phase 2 actions and re-run.',
  );
}

type Phase = 'loading' | 'select' | 'action' | 'applying' | 'done' | 'fatal';
type Item = {
  rule: Rule;
  active: boolean;
  action: ActionChoice;
  status: ApplyStatus;
  detail?: string;
};

/** Truncate a string to `n` chars with a trailing ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Next/previous valid action for a rule, wrapping around its option list. */
function cycleAction(item: Item, dir: 1 | -1): ActionChoice {
  const opts = actionOptions(item.rule);
  const i = opts.indexOf(item.action);
  const base = i < 0 ? 0 : i;
  return opts[(base + dir + opts.length) % opts.length];
}

/** One-line tally of apply outcomes for the done screen. */
function summaryLine(items: Item[]): string {
  const n = (s: ApplyStatus) => items.filter((it) => it.status === s).length;
  const parts: string[] = [];
  if (n('overwrote')) parts.push(`${n('overwrote')} overwrote`);
  if (n('inserted')) parts.push(`${n('inserted')} inserted`);
  if (n('error')) parts.push(`${n('error')} error`);
  return parts.join(', ') || 'no changes';
}

/** The right-hand side of a rule row: its description while selecting, its apply status otherwise. */
function RowTail({ item, phase }: { item: Item; phase: Phase }) {
  if (phase === 'select' || phase === 'action')
    return <Text dimColor>{truncate(item.rule.description, 50)}</Text>;
  const suffix = item.detail ? ` (${item.detail})` : '';
  switch (item.status) {
    case 'applying':
      return <Text color="yellow">… applying</Text>;
    case 'inserted':
      return <Text color="green">＋ inserted{suffix}</Text>;
    case 'overwrote':
      return <Text color="green">✔ overwrote{suffix}</Text>;
    case 'error':
      return <Text color="red">✖ {item.detail ?? 'error'}</Text>;
    default:
      return <Text dimColor>pending</Text>;
  }
}

/** A single rule row: cursor marker, active checkbox, name, action tag, then description/status. */
function Row({
  item,
  isCursor,
  phase,
}: {
  item: Item;
  isCursor: boolean;
  phase: Phase;
}) {
  const selecting = phase === 'select' || phase === 'action';
  return (
    <Box>
      <Text color="cyan">{isCursor && selecting ? '▶ ' : '  '}</Text>
      <Text color={item.active ? 'green' : 'gray'}>
        {item.active ? '[x]' : '[ ]'}{' '}
      </Text>
      <Text bold>{item.rule.name.padEnd(20)} </Text>
      <Text color={item.active ? actionColor(item.action) : 'gray'}>
        {`[${item.action.toUpperCase()}]`.padEnd(11)}{' '}
      </Text>
      <RowTail item={item} phase={phase} />
    </Box>
  );
}

/** Interactive firewall manager: toggle each rule on/off and switch its action (log/challenge/deny/bypass), then apply (upsert) to Vercel. */
function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [menuCursor, setMenuCursor] = useState(0);
  const [idByName, setIdByName] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');

  useEffect(() => {
    fetchLive()
      .then((live) => {
        setIdByName(live.idByName);
        setItems(
          rules.map((rule) => ({
            rule,
            active: live.activeByName.get(rule.name) ?? rule.active,
            action:
              live.actionByName.get(rule.name) ??
              asChoice(effectiveAction(rule.action.mitigate)) ??
              'log',
            status: 'idle',
          })),
        );
        setPhase('select');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('fatal');
      });
  }, []);

  /** Sequentially upsert each rule with its chosen active + action, updating per-row status as it goes. */
  const applyAll = async (snapshot: Item[], ids: Map<string, string>) => {
    for (let i = 0; i < snapshot.length; i++) {
      const idx = i;
      setItems((prev) =>
        prev.map((it, j) => (j === idx ? { ...it, status: 'applying' } : it)),
      );
      const rule = withAction(
        { ...snapshot[idx].rule, active: snapshot[idx].active },
        snapshot[idx].action,
      );
      try {
        const res = await applyRule(rule, ids);
        setItems((prev) =>
          prev.map((it, j) =>
            j === idx ? { ...it, status: res.status, detail: res.detail } : it,
          ),
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        setItems((prev) =>
          prev.map((it, j) =>
            j === idx ? { ...it, status: 'error', detail } : it,
          ),
        );
      }
    }
    setPhase('done');
  };

  useInput((input, key) => {
    if (phase === 'select') {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === 'j')
        setCursor((c) => Math.min(items.length - 1, c + 1));
      else if (key.leftArrow || input === 'h')
        setItems((prev) =>
          prev.map((it, j) =>
            j === cursor ? { ...it, action: cycleAction(it, -1) } : it,
          ),
        );
      else if (key.rightArrow || input === 'l')
        setItems((prev) =>
          prev.map((it, j) =>
            j === cursor ? { ...it, action: cycleAction(it, 1) } : it,
          ),
        );
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
      else if (input === 'a') {
        setPhase('applying');
        void applyAll(items, idByName);
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
  return (
    <Box flexDirection="column">
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
            isCursor={i === cursor}
            phase={phase}
          />
        ))}
      </Box>
      {phase === 'select' && (
        <Text dimColor>
          ↑/↓ move · ←/→ action · enter menu · space on/off · a apply · q quit (
          {onCount}/{items.length} on)
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
          <Text dimColor>↑/↓ choose · enter set · esc cancel</Text>
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
  );
}

if (process.stdout.isTTY && process.stdin.isTTY) {
  render(<App />);
} else {
  // No TTY (CI / piped): can't run the interactive UI — apply non-interactively.
  runHeadless().catch((error) => {
    console.error('firewall setup failed:', error);
    process.exit(1);
  });
}
