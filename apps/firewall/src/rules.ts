// The custom WAF rule set (config-as-code) plus its domain types. Pure config — no Vercel/Ink deps.

import { ASN_DENY, denyListRule, envMatching, JA4_DENY } from './deny-list';
import { CH_STREAM_REVALIDATE, DESKTOP_RELEASE_RECORD } from './rule-names';
import { envCeiling } from './util';

export type RateLimitAction = 'log' | 'challenge' | 'deny'; // rateLimit exceeded-action — bypass is NOT valid here
export type ActionChoice = 'log' | 'challenge' | 'deny' | 'bypass'; // a rule's switchable mitigate action
export type Condition = {
  type:
    | 'path'
    | 'query'
    | 'header'
    | 'user_agent'
    | 'ja4_digest'
    | 'geo_as_number';
  op: 'pre' | 'eq' | 'ex' | 'sub' | 're';
  key?: string;
  value?: string | string[];
  neg?: boolean;
};
export type Rule = {
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

// Phase 1 = observe: every rule logs only, nothing is blocked. Flip individual rules to challenge/deny/bypass in the TUI and apply.
const OBSERVE: RateLimitAction = 'log';
export const dryRun =
  process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

/** A REQUIRED ceiling (FW_*_LIMIT) — kept in .env.local, never the repo, so public code doesn't reveal the thresholds. Returns a placeholder in dry-run, which only lists rule names. */
function envLimit(name: string): number {
  const v = envCeiling(name);
  if (v !== undefined) return v;
  if (dryRun) return 0; // dry-run lists rule names only; real ceilings not needed
  throw new Error(
    `${name} must be a positive integer (set it in .env.local) — firewall ceilings are kept out of the repo`,
  );
}

/**
 * A REQUIRED value kept in .env.local, never the repo. Absent throws rather than returning empty:
 * a rule built without it is the PREVIOUS, weaker rule, and applying that would loosen the
 * firewall while looking like a successful apply.
 */
function envRequired(name: string, why: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (dryRun) return ''; // dry-run lists rule names only
  throw new Error(`${name} must be set in .env.local — ${why}`);
}

/** An OPTIONAL ceiling (FW_*_LIMIT), null when unset so the caller drops just that rule instead of failing the whole apply. */
function optionalLimit(name: string): number | null {
  const v = envCeiling(name);
  if (v !== undefined) return v;
  return dryRun ? 0 : null; // dry-run lists rule names only; real ceilings not needed
}

const SERVERFN_LIMIT = envLimit('FW_SERVERFN_LIMIT');
const SEARCH_LIMIT = envLimit('FW_SEARCH_LIMIT');
const TILES_LIMIT = envLimit('FW_TILES_LIMIT');
const JA4_LIMIT = envLimit('FW_JA4_LIMIT');
// REQUIRED: the widened burst tiers above are only safe because these hold the flat-rate
// line, so a missing var must abort the apply rather than silently ship burst-only.
const SERVERFN_SUSTAINED_LIMIT = envLimit('FW_SERVERFN_SUSTAINED_LIMIT');
const SEARCH_SUSTAINED_LIMIT = envLimit('FW_SEARCH_SUSTAINED_LIMIT');
// Opt-in: no burst tier depends on this one, so a missing var drops just this rule.
const DOWNLOADS_LIMIT = optionalLimit('FW_DOWNLOADS_LIMIT');
// Vercel Pro caps a rate-limit counting window at 10 minutes (1h is Enterprise).
const SUSTAINED_WINDOW = 600;
// The header name itself is the value here, so it stays in .env.local like every ceiling above.
const CH_STREAM_MARKER = envRequired(
  'REVALIDATE_MARKER_HEADER',
  'the allow rule requires it and would otherwise be rebuilt without that condition',
);

/** Build a per-key fixed-window rate-limit rule (60s unless `window` overrides), observe-mode unless `action` overrides it. */
function rateLimitRule(opts: {
  name: string;
  description: string;
  conditions: Condition[];
  limit: number;
  keys: string[];
  actionDuration: string;
  window?: number;
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
          window: opts.window ?? 60,
          limit: opts.limit,
          keys: opts.keys,
          action: opts.action ?? OBSERVE,
        },
        actionDuration: opts.actionDuration,
      },
    },
  };
}

/**
 * Build a header-gated path bypass — a trusted non-browser caller exempted from the managed Bot
 * Protection challenge it can't solve. Matching header PRESENCE keeps the secret out of firewall
 * config; the endpoint's timing-safe check stays the real gate. Only safe while `headerKey` is a
 * bespoke name no ordinary client sends — never a standard one like `authorization`.
 */
function bypassRule(opts: {
  name: string;
  description: string;
  path: string;
  headerKey: string;
  /** Further header names the caller must also send. Empty entries are a bug, not a no-op. */
  alsoHeaderKeys?: string[];
}): Rule {
  const also = opts.alsoHeaderKeys ?? [];
  // An empty entry would drop silently and rebuild the looser rule, so it fails the apply.
  if (also.some((k) => !k) && !dryRun)
    throw new Error(`${opts.name}: an additional header key resolved to empty`);
  return {
    name: opts.name,
    description: opts.description,
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'eq', value: opts.path },
          { type: 'header', op: 'ex', key: opts.headerKey },
          ...also
            .filter(Boolean)
            .map((key): Condition => ({ type: 'header', op: 'ex', key })),
        ],
      },
    ],
    action: { mitigate: { action: 'bypass' } },
  };
}

// Both REQUIRED (absent throws — see envMatching); values stay in .env.local, never this repo.
// Unlike observe-ja4-serverfn these match a digest rather than rate-limiting keyed by one, so
// isLogOnly() leaves them switchable. That rests on the operator having PROVEN the digest is
// non-browser: a shared browser fingerprint here denies everyone carrying it, and no code-level
// guard can tell the two apart.
const blockedJa4Rule = denyListRule({
  name: 'deny-scraper-ja4',
  description: 'Deny scraper TLS fingerprints (FW_BLOCKED_JA4).',
  spec: JA4_DENY,
  values: envMatching('FW_BLOCKED_JA4', JA4_DENY, !dryRun),
});

const blockedAsnRule = denyListRule({
  name: 'deny-scraper-asn',
  description:
    'Deny hosting ASNs that only ever serve scrapers (FW_BLOCKED_ASN).',
  spec: ASN_DENY,
  values: envMatching('FW_BLOCKED_ASN', ASN_DENY, !dryRun),
});

// Opt-in: empty (rule omitted) until FW_DOWNLOADS_LIMIT is provisioned, so a
// missing var drops just this rule instead of throwing the whole apply at import.
// Bespoke shape (OR-ed condition groups), so it can't use rateLimitRule.
const downloadsRules: Rule[] =
  DOWNLOADS_LIMIT === null
    ? []
    : [
        {
          name: 'rl-downloads-ip',
          // Keep <= 256 chars (Vercel's rule-description cap; over-length 400s
          // with a cryptic "action should be equal to constant"). The Range-
          // request rationale for excluding latest/ lives in the code comment below.
          description:
            'Per-IP rate limit on versioned desktop installer downloads (/downloads/{mac,win,linux}/) — curbs curl-loop amplification of the desktop_downloads counter; /downloads/latest/ (the updater feed) is intentionally NOT matched. Short block on trip.',
          active: true,
          // Positive per-platform prefixes as OR-ed condition groups — NOT a
          // negated "/downloads/ AND NOT /downloads/latest/", which Vercel's API
          // rejects (400 "action should be equal to constant": neg is only valid
          // on some ops, not `pre`). Same versioned surface, latest/ untouched.
          // Platforms = DESKTOP_PLATFORMS; add a group if a new one ships.
          conditionGroup: [
            {
              conditions: [
                { type: 'path', op: 'pre', value: '/downloads/mac/' },
              ],
            },
            {
              conditions: [
                { type: 'path', op: 'pre', value: '/downloads/win/' },
              ],
            },
            {
              conditions: [
                { type: 'path', op: 'pre', value: '/downloads/linux/' },
              ],
            },
          ],
          action: {
            mitigate: {
              action: 'rate_limit',
              rateLimit: {
                algo: 'fixed_window',
                window: 60,
                limit: DOWNLOADS_LIMIT,
                keys: ['ip'],
                action: OBSERVE,
              },
              // A single installer fetch can issue several Range requests, so a
              // legitimate download must never cost an hour of lockout.
              actionDuration: '15m',
            },
          },
        },
      ];

/** Custom WAF rules for the expensive paths (search RPC, SSR search, tile proxy); ceilings are calibrated from measured peaks, not guessed. Upsert-only — renaming a rule orphans the live one, so delete that in the dashboard. */
export const rules: Rule[] = [
  // ALLOW (first — allow rules take precedence): trusted server-to-server callers.
  bypassRule({
    name: CH_STREAM_REVALIDATE,
    description:
      'Bypass bot protection for ch-stream → POST /api/revalidate (trusted server-to-server cache invalidation; endpoint auths via x-revalidate-secret). Skips the managed Bot Protection challenge that blocks non-browser callers.',
    path: '/api/revalidate',
    headerKey: 'x-revalidate-secret',
    alsoHeaderKeys: [CH_STREAM_MARKER],
  }),
  bypassRule({
    name: DESKTOP_RELEASE_RECORD,
    description:
      'Bypass bot protection for the desktop release workflow → POST /api/releases (CI records a release; endpoint auths via x-desktop-release-secret). Skips the managed challenge that 429s non-browser callers.',
    path: '/api/releases',
    headerKey: 'x-desktop-release-secret',
  }),
  // Position here is documentation only: live priority is INSERTION order (applyRule appends).
  blockedJa4Rule,
  blockedAsnRule,
  // Two tiers per path: BURST (60s) sized well above a real session so humans never trip it,
  // SUSTAINED (10m) holding the flat rate. Humans burst then idle; scrapers run level.
  rateLimitRule({
    name: 'rl-serverfn-ip',
    description:
      'Per-IP BURST ceiling (60s) on server-fn RPCs (searchHmrc + detail lookups). Sized several times above the busiest real browser session so heavy users are never blocked; paced scraping is caught by rl-serverfn-ip-sustained instead. Short block on trip.',
    conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }],
    limit: SERVERFN_LIMIT,
    keys: ['ip'],
    actionDuration: '10m',
  }),
  rateLimitRule({
    name: 'rl-serverfn-ip-sustained',
    limit: SERVERFN_SUSTAINED_LIMIT,
    description:
      'Per-IP SUSTAINED ceiling (10m window, Vercel Pro max) on server-fn RPCs. Holds flat-rate throughput at the pre-burst-raise level: a real session bursts then idles and stays far under, while level-rate enumeration trips it. Deny + 1h.',
    conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }],
    keys: ['ip'],
    window: SUSTAINED_WINDOW,
    actionDuration: '1h',
    // Enforces on insert: log mode would make the widened burst tier a net loosening.
    action: 'deny',
  }),
  rateLimitRule({
    name: 'rl-ssr-search-ip',
    description:
      'Per-IP BURST ceiling (60s) on SSR search enumeration (/?search=). Well above real browsing (tab restores, rapid refinement); sustained enumeration is caught by rl-ssr-search-ip-sustained. Short block on trip.',
    conditions: [
      { type: 'path', op: 'eq', value: '/' },
      { type: 'query', op: 'ex', key: 'search' },
    ],
    limit: SEARCH_LIMIT,
    keys: ['ip'],
    actionDuration: '10m',
  }),
  rateLimitRule({
    name: 'rl-ssr-search-ip-sustained',
    limit: SEARCH_SUSTAINED_LIMIT,
    description:
      'Per-IP SUSTAINED ceiling (10m window) on SSR search enumeration (/?search=) — catches level-rate result enumeration that ducks under the 60s burst ceiling. Deny + 1h.',
    conditions: [
      { type: 'path', op: 'eq', value: '/' },
      { type: 'query', op: 'ex', key: 'search' },
    ],
    keys: ['ip'],
    window: SUSTAINED_WINDOW,
    actionDuration: '1h',
    action: 'deny', // see rl-serverfn-ip-sustained
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
  ...downloadsRules,
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
            // Host-anchored allowlist mirroring the tile route's isAllowedReferer ([y].get.ts): prod sponsorsearch.co.uk (+ subdomains) AND this team's Vercel preview hosts (learn-tanstack-start-*-nikil-kuruvillas-projects.vercel.app — only this team deploys under that suffix). *.evil.com suffixes still fail. Keep the two in sync.
            value:
              '^https?://(([a-z0-9-]+\\.)*sponsorsearch\\.co\\.uk|learn-tanstack-start-[a-z0-9-]+-nikil-kuruvillas-projects\\.vercel\\.app)([/:?#].*)?$',
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
      'Observe per-JA4 volume on server-fn RPCs — surfaces a distributed scraper using one TLS fingerprint across many IPs that per-IP rules miss. LOG ONLY: browser JA4s are shared by millions of real users, so it is locked to log (see isLogOnly).',
    conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }],
    limit: JA4_LIMIT,
    keys: ['ja4_digest'],
    actionDuration: '1h',
    action: 'log',
  }),
];

// Vercel caps a rule's description at 256 chars; over-length ones fail the apply
// with a cryptic 400 "Invalid request: `action` should be equal to constant."
// (an hour of misdirection). Fail fast with a clear message instead.
for (const r of rules) {
  const len = r.description?.length ?? 0;
  if (len > 256)
    throw new Error(
      `Firewall rule "${r.name}" description is ${len} chars — Vercel's limit is 256. Shorten it.`,
    );
}
