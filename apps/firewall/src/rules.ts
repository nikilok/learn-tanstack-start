// The custom WAF rule set (config-as-code) plus its domain types. Pure config — no Vercel/Ink deps.

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
const DOWNLOADS_LIMIT = envLimit('FW_DOWNLOADS_LIMIT');

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

/** Custom WAF rules scoped to SponsorSearch's real expensive paths (search RPC, SSR search, tile proxy) — complements the managed Bot Protection ruleset. Googlebot doesn't hit these paths, so SEO is untouched. Limits are observe-mode starting points; calibrate from Firewall → Traffic before enforcing. NOTE: this set is upsert-only — renaming/removing a rule here orphans the old live rule; delete it in the dashboard. */
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
  rateLimitRule({
    name: 'rl-downloads-ip',
    description:
      'Per-IP rate limit on versioned desktop installer downloads (/downloads/<platform>/<guid>/<version>/) — caps curl-loop amplification of the desktop_downloads counter. EXCLUDES /downloads/latest/ (the electron-updater feed, whose differential Range-requests must not be throttled). Phase 1: log.',
    conditions: [
      { type: 'path', op: 'pre', value: '/downloads/' },
      { type: 'path', op: 'pre', value: '/downloads/latest/', neg: true },
    ],
    limit: DOWNLOADS_LIMIT,
    keys: ['ip'],
    actionDuration: '1h',
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
