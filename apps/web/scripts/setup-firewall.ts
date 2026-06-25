import { readFileSync } from 'node:fs';

import { Vercel } from '@vercel/sdk';

type RateLimitAction = 'log' | 'challenge' | 'deny';
type Condition = {
  type: 'path' | 'query' | 'header';
  op: 'pre' | 'eq' | 'ex' | 'sub';
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
      action: 'rate_limit' | RateLimitAction;
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

// Phase 1 = observe: every rule logs only, nothing is blocked. For Phase 2, set the rate-limit/hotlink actions to 'challenge'/'deny' below and re-run.
const OBSERVE: RateLimitAction = 'log';

// Per-IP ceilings live in .env.local / Vercel env (FW_*_LIMIT), not the repo, so the
// public code never reveals the rate-limit thresholds to scrapers.
function envLimit(name: string): number {
  const v = Number(process.env[name]);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(
      `${name} must be a positive integer (set it in .env.local) — firewall ceilings are kept out of the repo`,
    );
  }
  return v;
}

const SERVERFN_LIMIT = envLimit('FW_SERVERFN_LIMIT');
const SEARCH_LIMIT = envLimit('FW_SEARCH_LIMIT');
const TILES_LIMIT = envLimit('FW_TILES_LIMIT');
const JA4_LIMIT = envLimit('FW_JA4_LIMIT');

/** Custom WAF rules scoped to SponsorSearch's real expensive paths (search RPC, SSR search, tile proxy) — complements the managed Bot Protection ruleset. Googlebot doesn't hit these paths, so SEO is untouched. Limits are observe-mode starting points; calibrate from Firewall → Traffic before enforcing. */
const rules: Rule[] = [
  {
    name: 'rl-serverfn-ip',
    description:
      'Per-IP rate limit on server-fn RPCs (searchHmrc + detail lookups). Phase 1: log.',
    active: true,
    conditionGroup: [
      { conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }] },
    ],
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit: SERVERFN_LIMIT,
          keys: ['ip'],
          action: OBSERVE,
        },
        actionDuration: '1h',
      },
    },
  },
  {
    name: 'rl-ssr-search-ip',
    description:
      'Per-IP rate limit on SSR search enumeration (/?search=). Phase 1: log.',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'eq', value: '/' },
          { type: 'query', op: 'ex', key: 'search' },
        ],
      },
    ],
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit: SEARCH_LIMIT,
          keys: ['ip'],
          action: OBSERVE,
        },
        actionDuration: '1h',
      },
    },
  },
  {
    name: 'rl-tiles-ip',
    description:
      'Per-IP rate limit on the Stadia tile proxy (bursts on pan/zoom, so high). Phase 1: log.',
    active: true,
    conditionGroup: [
      { conditions: [{ type: 'path', op: 'pre', value: '/api/tiles' }] },
    ],
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit: TILES_LIMIT,
          keys: ['ip'],
          action: OBSERVE,
        },
        actionDuration: '15m',
      },
    },
  },
  {
    name: 'tile-hotlink',
    description:
      'Off-site tile hotlinking (Referer present and not our domain). Phase 1: log; Phase 2: deny.',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'pre', value: '/api/tiles' },
          { type: 'header', op: 'ex', key: 'referer' },
          {
            type: 'header',
            op: 'sub',
            key: 'referer',
            value: 'sponsorsearch.co.uk',
            neg: true,
          },
        ],
      },
    ],
    action: { mitigate: { action: OBSERVE } },
  },
  {
    name: 'observe-ja4-serverfn',
    description:
      'Observe per-JA4 volume on server-fn RPCs — surfaces a distributed scraper using one TLS fingerprint across many IPs that per-IP rules miss. LOG ONLY: browser JA4s are shared by millions of real users, so never flip this to enforce.',
    active: true,
    conditionGroup: [
      { conditions: [{ type: 'path', op: 'pre', value: '/_serverFn' }] },
    ],
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit: JA4_LIMIT,
          keys: ['ja4_digest'],
          action: 'log', // never 'deny'/'challenge' — would nuke real browsers sharing a JA4
        },
        actionDuration: '1h',
      },
    },
  },
];

const link = JSON.parse(
  readFileSync(new URL('../.vercel/project.json', import.meta.url), 'utf8'),
) as { projectId: string; orgId: string };
const projectId = process.env.VERCEL_PROJECT_ID ?? link.projectId;
const teamId = process.env.VERCEL_TEAM_ID ?? link.orgId;
const bearerToken = process.env.VERCEL_TOKEN;
if (!bearerToken) {
  throw new Error(
    'VERCEL_TOKEN not set — create one at https://vercel.com/account/tokens',
  );
}

const vercel = new Vercel({ bearerToken });

/** Upsert every rule by name (insert new, update existing in place) so the script is safe to re-run. Custom rules apply on save — no redeploy. */
async function main() {
  const config = await vercel.security.getFirewallConfig({
    projectId,
    teamId,
    configVersion: 'active',
  });
  const idByName = new Map((config.rules ?? []).map((r) => [r.name, r.id]));
  const dryRun =
    process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

  for (const value of rules) {
    const id = idByName.get(value.name);
    if (dryRun) {
      console.log(`would ${id ? 'update' : 'insert'} ${value.name}`);
      continue;
    }
    if (id) {
      await vercel.security.updateFirewallConfig({
        projectId,
        teamId,
        requestBody: { action: 'rules.update', id, value },
      });
      console.log(`updated  ${value.name}`);
    } else {
      await vercel.security.updateFirewallConfig({
        projectId,
        teamId,
        requestBody: { action: 'rules.insert', value },
      });
      console.log(`inserted ${value.name}`);
    }
  }
  console.log(
    '\nPhase 1 (log) applied. Watch Firewall → Traffic, then set Phase 2 actions and re-run.',
  );
}

main().catch((error) => {
  console.error('firewall setup failed:', error);
  process.exit(1);
});
