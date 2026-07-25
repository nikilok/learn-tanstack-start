// The custom WAF rule set (config-as-code) plus its domain types. Pure config — no Vercel/Ink deps.

import { envCeiling } from './util';

export type RateLimitAction = 'log' | 'challenge' | 'deny'; // rateLimit exceeded-action — bypass is NOT valid here
export type ActionChoice = 'log' | 'challenge' | 'deny' | 'bypass'; // a rule's switchable mitigate action
type Condition = {
  type: 'path' | 'query' | 'header';
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

/** An OPTIONAL ceiling (FW_*_LIMIT), null when unset so the caller omits just that rule. Unlike envLimit this must NOT throw — a missing var would crash the whole apply (taking down every rule) instead of dropping one. */
function optionalLimit(name: string): number | null {
  const v = envCeiling(name);
  if (v !== undefined) return v;
  return dryRun ? 0 : null; // dry-run lists rule names only; real ceilings not needed
}

const SERVERFN_LIMIT = envLimit('FW_SERVERFN_LIMIT');
const SEARCH_LIMIT = envLimit('FW_SEARCH_LIMIT');
const TILES_LIMIT = envLimit('FW_TILES_LIMIT');
const JA4_LIMIT = envLimit('FW_JA4_LIMIT');
// REQUIRED, not opt-in: the burst ceilings above are set several times higher than real
// browser traffic only because these hold the flat-rate line. If a missing var merely
// dropped its rule, an apply would quietly ship the widened burst tier with the control
// that justified widening it absent — a pure loosening whose only trace is one missing row
// in the output. Throwing aborts the whole apply instead, which changes nothing in prod.
const SERVERFN_SUSTAINED_LIMIT = envLimit('FW_SERVERFN_SUSTAINED_LIMIT');
const SEARCH_SUSTAINED_LIMIT = envLimit('FW_SEARCH_SUSTAINED_LIMIT');
// Opt-in: no burst tier depends on this one, so a missing var drops just this rule.
const DOWNLOADS_LIMIT = optionalLimit('FW_DOWNLOADS_LIMIT');

// Vercel Pro caps a rate-limit counting window at 10 minutes (1h is Enterprise).
const SUSTAINED_WINDOW = 600;

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

/** Build a header-gated path bypass — a trusted non-browser server-to-server caller exempted from the managed Bot Protection challenge it can't solve. Matching on header PRESENCE (not value) keeps the secret out of firewall config; the endpoint's timing-safe secret check stays the real auth gate. */
function bypassRule(opts: {
  name: string;
  description: string;
  path: string;
  headerKey: string;
}): Rule {
  return {
    name: opts.name,
    description: opts.description,
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'eq', value: opts.path },
          { type: 'header', op: 'ex', key: opts.headerKey },
        ],
      },
    ],
    action: { mitigate: { action: 'bypass' } },
  };
}

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

/** Custom WAF rules scoped to SponsorSearch's real expensive paths (search RPC, SSR search, tile proxy) — complements the managed Bot Protection ruleset. Googlebot's own rate sits far under every ceiling, so SEO is untouched. Ceilings are calibrated against measured peak per-IP burst and 10-minute volume (see the two-tier note below), not guessed. NOTE: this set is upsert-only — renaming/removing a rule here orphans the old live rule; delete it in the dashboard. */
export const rules: Rule[] = [
  // ALLOW (first — allow rules take precedence): trusted server-to-server callers.
  bypassRule({
    name: 'allow-ch-stream-revalidate',
    description:
      'Bypass bot protection for ch-stream → POST /api/revalidate (trusted server-to-server cache invalidation; endpoint auths via x-revalidate-secret). Skips the managed Bot Protection challenge that blocks non-browser callers.',
    path: '/api/revalidate',
    headerKey: 'x-revalidate-secret',
  }),
  bypassRule({
    name: 'allow-desktop-release-record',
    description:
      'Bypass bot protection for the desktop release workflow → POST /api/releases (CI records a release; endpoint auths via x-desktop-release-secret). Skips the managed challenge that 429s non-browser callers.',
    path: '/api/releases',
    headerKey: 'x-desktop-release-secret',
  }),
  // Two tiers per expensive path. BURST (60s) is sized several times above the
  // busiest observed real browser session, so a heavy human never trips it; a
  // short actionDuration keeps any false positive cheap. SUSTAINED (10m) holds
  // the flat-rate ceiling: humans burst then idle, scrapers run level, so paced
  // enumeration that ducks under the burst tier is caught here instead. Raising
  // burst alone would just hand a scraper more throughput — the pair is the point.
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
    // Enforces on insert (not OBSERVE): it carries the enforcement the widened
    // burst tier gives up, so shipping it in log mode would be a net loosening.
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
