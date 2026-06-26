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

/** Custom WAF rules scoped to SponsorSearch's real expensive paths (search RPC, SSR search, tile proxy) — complements the managed Bot Protection ruleset. Googlebot doesn't hit these paths, so SEO is untouched. Limits are observe-mode starting points; calibrate from Firewall → Traffic before enforcing. NOTE: this set is upsert-only — renaming/removing a rule here orphans the old live rule; delete it in the dashboard. */
export const rules: Rule[] = [
  // ALLOW (first — allow rules take precedence): ch-stream (Railway) → POST /api/revalidate is a
  // trusted server-to-server caller (CDN cache invalidation), authed by the x-revalidate-secret
  // header check in the endpoint. A bypass rule exempts it from the managed Bot Protection ruleset,
  // which otherwise serves a JS challenge the non-browser caller can't solve and blocks it. Matching
  // on the header's presence (not value) keeps the secret out of the firewall config — the endpoint's
  // timing-safe secret check stays the real auth gate.
  {
    name: 'allow-ch-stream-revalidate',
    description:
      'Bypass bot protection for ch-stream → POST /api/revalidate (trusted server-to-server cache invalidation; endpoint auths via x-revalidate-secret). Skips the managed Bot Protection challenge that blocks non-browser callers.',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'eq', value: '/api/revalidate' },
          { type: 'header', op: 'ex', key: 'x-revalidate-secret' },
        ],
      },
    ],
    action: { mitigate: { action: 'bypass' } },
  },
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
