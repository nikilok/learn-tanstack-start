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
          conditions: [{ type: 'user_agent' as const, op: 'sub' as const, value }],
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

/**
 * The code-level pairing cannot stop an operator deactivating the ceiling in the TUI and leaving
 * the bypass live. Detects that state so the caller can say so out loud.
 */
export function unboundedPreviewBypass(
  items: { name: string; active: boolean; action: string }[],
): string | undefined {
  const bypass = items.find((i) => i.name === PREVIEW_BYPASS_RULE);
  if (!bypass?.active || bypass.action !== 'bypass') return undefined;
  const ceiling = items.find((i) => i.name === PREVIEW_CEILING_RULE);
  if (!ceiling || !ceiling.active)
    return `${PREVIEW_BYPASS_RULE} is live but ${PREVIEW_CEILING_RULE} is ${ceiling ? 'DEACTIVATED' : 'MISSING'} — a spoofed preview User-Agent now skips bot protection with nothing bounding it`;
  if (ceiling.action === 'log')
    return `${PREVIEW_BYPASS_RULE} is live but ${PREVIEW_CEILING_RULE} is log-only — the ceiling counts but never blocks, so the bypass is effectively unbounded`;
  return undefined;
}
