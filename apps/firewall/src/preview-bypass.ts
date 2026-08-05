// Link-preview crawlers (WhatsApp, Slack, X, …) are non-browser clients, so managed Bot
// Protection challenges them and a shared link renders a dead card. This exempts them — but a
// User-Agent is caller-controlled, so the exemption ships as a PAIR: a per-IP ceiling that
// evaluates first, then the bypass. Never emit one without the other.

import type { Condition, Rule } from './rules';

// Only what a preview card needs: the shared page and the og: image. NOT /_serverFn, not
// sitemaps — a spoofed UA must not reach the RPC surface with bot protection skipped.
const SCOPES: Condition[] = [
  { type: 'path', op: 'eq', value: '/' },
  { type: 'path', op: 'pre', value: '/company/' },
  { type: 'path', op: 'pre', value: '/og' },
];

// Matched as a case-sensitive substring of the UA, so tokens must be spelled as they appear.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,63}$/;

// Vercel ANDs the conditions within a group, and one request path cannot be two values, so this
// group can never match. Revocation needs it: applyRule is upsert-only, so an omitted bypass
// stays live and keeps skipping bot protection, unrevokably and invisible to the TUI.
const UNMATCHABLE = [
  {
    conditions: [
      { type: 'path' as const, op: 'eq' as const, value: '/' },
      { type: 'path' as const, op: 'eq' as const, value: '/.preview-revoked' },
    ],
  },
];

const REVOKED = ' REVOKED — FW_PREVIEW_UA is unset, so this matches nothing.';

/** Marks a revoked rule in the dashboard list, which otherwise reads as still doing something. Idempotent. */
function previewDescription(base: string, active: boolean): string {
  const clean = base.replace(REVOKED, '');
  return active ? clean : `${clean}${REVOKED}`;
}

/** Parse FW_PREVIEW_UA. Absent or blank disables the feature entirely (no rules, no error); a malformed entry throws naming its position, never its value. */
export function previewTokens(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((part, i) => {
    const token = part.trim();
    if (!TOKEN.test(token))
      throw new Error(
        `FW_PREVIEW_UA entry #${i + 1} is malformed (expected a User-Agent product token, 2 to 64 chars of letters, digits, space . _ / -)`,
      );
    return token;
  });
}

/**
 * The ceiling that makes the bypass safe to publish. A genuine preview is one or two fetches per
 * shared link; enumeration behind a spoofed UA is not. Emitted BEFORE the bypass so it still
 * evaluates — a bypass short-circuits everything after it, and live priority is insertion order.
 */
function previewCeilingRule(tokens: string[], limit: number): Rule {
  return {
    name: 'rl-preview-ua',
    description: previewDescription(
      'Per-IP ceiling on link-preview user agents (FW_PREVIEW_UA/FW_PREVIEW_LIMIT). Bounds what allow-social-preview can be used for. Must stay ordered BEFORE it.',
      tokens.length > 0,
    ),
    active: true,
    conditionGroup: tokens.length
      ? tokens.map((value) => ({
          conditions: [
            { type: 'user_agent' as const, op: 'sub' as const, value },
          ],
        }))
      : UNMATCHABLE,
    action: {
      mitigate: {
        action: 'rate_limit',
        rateLimit: {
          algo: 'fixed_window',
          window: 60,
          limit,
          keys: ['ip'],
          action: 'deny',
        },
        // A false positive costs one missing preview card, so keep the block short.
        actionDuration: '10m',
      },
    },
  };
}

/** The exemption itself: one OR-ed group per (token, scope), since Vercel ANDs within a group. */
function previewBypassRule(tokens: string[]): Rule {
  return {
    name: 'allow-social-preview',
    description: previewDescription(
      'Bypass bot protection for link-preview crawlers (FW_PREVIEW_UA) on the shared page and og: image only, so shared links render a card. Bounded by rl-preview-ua.',
      tokens.length > 0,
    ),
    active: true,
    conditionGroup: tokens.length
      ? tokens.flatMap((value) =>
          SCOPES.map((scope) => ({
            conditions: [
              { type: 'user_agent' as const, op: 'sub' as const, value },
              scope,
            ],
          })),
        )
      : UNMATCHABLE,
    action: { mitigate: { action: 'bypass' } },
  };
}

/**
 * Both rules, or neither. A UA list without a ceiling is a published bypass with nothing bounding
 * it, so that combination throws rather than shipping half the control. Order is load-bearing:
 * the caller must splice these in as returned. Clearing FW_PREVIEW_UA emits the pair revoked
 * rather than omitting it — an omitted rule is never deleted, so it would stay live.
 */
export function previewRules(
  raw: string | undefined,
  limit: number | null,
): Rule[] {
  const tokens = previewTokens(raw);
  // The ceiling is only load-bearing while the bypass matches something; a revoked pair needs no
  // limit, and demanding one would make the documented off-switch throw.
  if (!tokens.length) return [previewCeilingRule([], 1), previewBypassRule([])];
  // `<= 0` too: a zero ceiling would deny every preview, and it is what a placeholder looks like.
  if (limit === null || !Number.isInteger(limit) || limit <= 0)
    throw new Error(
      'FW_PREVIEW_UA is set but FW_PREVIEW_LIMIT is not — the bypass is only safe behind its ceiling. Set both, or clear FW_PREVIEW_UA to disable previews.',
    );
  return [previewCeilingRule(tokens, limit), previewBypassRule(tokens)];
}

export const PREVIEW_BYPASS_RULE = 'allow-social-preview';
export const PREVIEW_CEILING_RULE = 'rl-preview-ua';

/** True when every condition group holds a contradiction, so the rule can never match a request. Recognises the revocation placeholder by its shape rather than its literal value. */
export function ruleMatchesNothing(rule: Rule): boolean {
  if (!rule.conditionGroup.length) return true;
  return rule.conditionGroup.every((g) => {
    const seen = new Map<string, Set<string>>();
    for (const c of g.conditions) {
      if (c.op !== 'eq' || typeof c.value !== 'string') continue;
      const set = seen.get(c.type) ?? new Set<string>();
      set.add(c.value);
      seen.set(c.type, set);
    }
    // Two different `eq` values for one dimension, ANDed together, can never both hold.
    return [...seen.values()].some((s) => s.size > 1);
  });
}

export type PreviewRuleState = {
  name: string;
  active: boolean;
  action: string;
  /** False when the rule's conditions cannot match anything (the revoked placeholder). */
  matches: boolean;
  /** Position in the LIVE config. Undefined means "not live yet", and an insert appends to the END. */
  order?: number;
  /** True when a write failed, so what is actually live is unknown. Judged worst-case per role. */
  unknown?: boolean;
};

/**
 * The code-level pairing cannot stop an operator deactivating the ceiling, cycling it to log,
 * revoking it, or leaving it ordered after the bypass. Detects every state in which the bypass
 * is live and matching while nothing bounds it.
 */
export function unboundedPreviewBypass(
  items: PreviewRuleState[],
): string | undefined {
  const bypass = items.find((i) => i.name === PREVIEW_BYPASS_RULE);
  if (!bypass) return undefined;
  // A failed write leaves the PREVIOUS rule live, so "we could not write it" is not "it is off".
  // Worst case for the bypass is that it is live and matching.
  const bypassLive =
    bypass.unknown || (bypass.active && bypass.action === 'bypass');
  const bypassMatches = bypass.unknown || bypass.matches;
  if (!bypassLive || !bypassMatches) return undefined;

  const ceiling = items.find((i) => i.name === PREVIEW_CEILING_RULE);
  const lead = `${PREVIEW_BYPASS_RULE} is live but ${PREVIEW_CEILING_RULE}`;
  if (!ceiling)
    return `${lead} is MISSING — a spoofed preview User-Agent now skips bot protection with nothing bounding it`;
  // Worst case for the ceiling is the opposite: assume it did NOT land.
  if (ceiling.unknown)
    return `${lead} failed to write, so what is live is unknown — treat the bypass as unbounded until it is confirmed`;
  if (!ceiling.active)
    return `${lead} is DEACTIVATED — a spoofed preview User-Agent now skips bot protection with nothing bounding it`;
  if (ceiling.action === 'log')
    return `${lead} is log-only — the ceiling counts but never blocks, so the bypass is effectively unbounded`;
  if (!ceiling.matches)
    return `${lead} matches nothing — it is present and active but bounds no request`;
  // Live priority is insertion order and a bypass short-circuits everything after it, so a
  // ceiling ordered later never evaluates. Undefined order means "will be appended last".
  const at = (i: PreviewRuleState) => i.order ?? Number.POSITIVE_INFINITY;
  if (at(ceiling) > at(bypass))
    return `${lead} is ordered AFTER it — a bypass short-circuits everything below, so the ceiling never evaluates`;
  return undefined;
}
