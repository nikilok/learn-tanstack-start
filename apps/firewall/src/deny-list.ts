// Env-driven identity denylists. Never put a value in an error or log line: --apply output is public.

import { isRecoverableRule } from './rule-names';
import type { Condition, Rule } from './rules';

// Narrower than Condition['type']: header/query need a `key` this factory never forwards.
export type DenyType = 'ja4_digest' | 'geo_as_number' | 'user_agent';

export type DenySpec = {
  type: DenyType;
  /** Match operator. Defaults to exact; `sub` is substring, which only user-agent tokens want. */
  op?: 'eq' | 'sub';
  valid: (v: string) => boolean;
  normalize: (v: string) => string;
  example: string; // describes the shape; never paste-able, or the error becomes a match-nothing template
  placeholder: string; // valid, unmatchable; asserted against `valid` in denyListRule
};

/** What a list rule does on a match. Narrower than ActionChoice: a list never logs or bypasses. */
export type ListAction = 'deny' | 'challenge';
type ListVerb = 'denied' | 'challenged' | 'listed';

const MAX_ASN = 4_294_967_295;

/**
 * Substrings that appear in ordinary browser user agents.
 *
 * A user-agent deny is a SUBSTRING match, so `Mozilla` would deny every browser on earth in one
 * env edit — the largest single-keystroke outage available in this tool. A token containing any
 * of these is refused rather than trusted to be deliberate.
 */
const UA_TOKENS_EVERY_BROWSER_SENDS = [
  'mozilla',
  'applewebkit',
  'khtml',
  'gecko',
  'chrome',
  'chromium',
  'safari',
  'firefox',
  'edge',
  'version',
  'windows',
  'macintosh',
  'linux',
  'x11',
  'android',
  'iphone',
  'ipad',
  'mobile',
  'compatible',
  'like',
];

/** Shortest token allowed. Three characters is a substring of far too much. */
const MIN_UA_TOKEN = 4;

/**
 * Real user agents, verbatim, to test a candidate token AGAINST.
 *
 * The word list above catches a token that CONTAINS a browser word. It cannot catch the opposite
 * and more dangerous case: a token that IS a fragment of every browser's UA. `Edg/` passes the
 * word test (the list says `edge`, Chromium Edge sends `Edg/`), as do `/5.0` and `rv:1` — each
 * four printable characters, each a substring of a real browser's UA, each denying every visitor
 * once `op: 'sub'` matches it.
 *
 * Testing containment in BOTH directions is the only form of this check that holds.
 */
const REAL_BROWSER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
];

/** Whether a user-agent token is specific enough to deny on. Exported for the test to enumerate. */
export function uaTokenIsSafe(v: string): boolean {
  if (v.length < MIN_UA_TOKEN || v.length > 120) return false;
  // Printable ASCII only: a control character cannot appear in a real header and a non-ASCII one
  // will not survive the round trip through the firewall config intact.
  if (!/^[\x20-\x7e]+$/.test(v)) return false;
  const lower = v.toLowerCase();
  if (UA_TOKENS_EVERY_BROWSER_SENDS.some((t) => lower.includes(t)))
    return false;
  // The other direction. A token no browser word appears INSIDE can still be a fragment OF one.
  return !REAL_BROWSER_AGENTS.some((ua) => ua.includes(v));
}

/**
 * Deny by the name a bot calls itself.
 *
 * Narrower than the JA4 lever and usually the right one for a crawler that identifies honestly:
 * a fingerprint is a client BUILD shared by whoever else compiled the same TLS stack, while the
 * token is the bot alone. Measured on ShapBot — the JA4 lever caught 10 requests from an
 * unrelated Linux Chrome, the token caught zero.
 *
 * It is trivially spoofable, and that is not the weakness it appears to be: a verified crawler
 * that changes its UA to evade loses the verification it wants, and lands back in the screen.
 *
 * Stored verbatim, never case-folded — the match is case-sensitive, so normalising here would
 * silently stop it matching.
 */
export const UA_DENY: DenySpec = {
  type: 'user_agent',
  op: 'sub',
  valid: uaTokenIsSafe,
  normalize: (v) => v,
  example:
    'a distinctive user-agent token, 4-120 printable characters, not a substring every browser sends',
  placeholder: '__no-such-agent__',
};

export const JA4_DENY: DenySpec = {
  type: 'ja4_digest',
  valid: (v) => /^[a-z0-9]{10}(_[0-9a-f]{12}){2}$/.test(v),
  normalize: (v) => v.toLowerCase(), // dashboards render hashes upper-case
  example:
    'a JA4 digest: 10-char profile + two 12-char hex hashes, underscore-separated',
  placeholder: 't13d1516h2_000000000000_000000000000',
};

export const ASN_DENY: DenySpec = {
  type: 'geo_as_number',
  // No AS0 (RFC 7607); no leading zeros, which Vercel reads as a different string.
  valid: (v) => /^[1-9]\d{0,9}$/.test(v) && Number(v) <= MAX_ASN,
  normalize: (v) => v,
  example: `a bare AS number, 1 to ${MAX_ASN}`,
  placeholder: '64512', // RFC 6996 private-use
};

/** Absent throws, blank revokes, separators-only throws — a quietly-empty list un-bans what is live. */
export function envMatching(
  name: string,
  spec: DenySpec,
  required: boolean,
): string[] {
  const raw = process.env[name];
  if (raw === undefined) {
    if (!required) return [];
    throw new Error(
      `${name} must be set in .env.local (comma-separated; set it EMPTY to revoke) — omitting it would silently un-ban whatever is live`,
    );
  }
  if (raw.trim() === '') return [];
  const parts = raw.split(',').map((s) => s.trim());
  const values: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (part === '')
      throw new Error(
        `${name} entry #${i + 1} is blank (a stray comma?) — set the whole var EMPTY to revoke`,
      );
    const value = spec.normalize(part);
    if (!spec.valid(value))
      throw new Error(
        `${name} entry #${i + 1} is malformed (expected ${spec.example})`,
      );
    values.push(value);
  }
  return values;
}

/** The values a deny rule currently matches, with the revocation placeholder dropped — it stands for "nothing", not for a real entry. */
export function valuesOf(rule: Rule, spec: DenySpec): string[] {
  return (
    rule.conditionGroup
      // The identity condition only. Exempt paths are negated conditions in the same group, so
      // reading every condition's value would return /robots.txt as though it were a denied digest.
      .flatMap((g) =>
        g.conditions.filter((c) => c.type === spec.type).map((c) => c.value),
      )
      .filter((v): v is string => typeof v === 'string')
      .filter((v) => v !== spec.placeholder)
  );
}

/**
 * The parts of a list rule that a rebuild must carry over, read back off the rule itself.
 *
 * withValue/withoutValue reconstruct a rule from name + description + values, so anything they do
 * not read is DROPPED. That already cost the policy-document exemption: it was added to the rule
 * definitions, and staging a digest in the TUI rebuilt the rule without it, so the next apply
 * removed the exemption from the live WAF with nothing reporting a change. Deriving beats
 * re-passing — a caller cannot forget what it never has to supply.
 */
export function listShapeOf(rule: Rule): {
  action: ListAction;
  exemptPaths: ExemptPath[];
} {
  // From the rule's IDENTITY, not its current action. A recoverable rule switched to `log` fell
  // through to 'deny' here, so merely staging an entry on a disabled tier rebuilt it as a hard
  // deny — an escalation needing no action keypress at all.
  const action = rule.action.mitigate.action;
  // Keyed on op AND path. Reading back only the value silently downgraded every prefix exemption
  // to an exact match on the first rebuild — and `withValue` rebuilds on every staged digest, so
  // the next apply would have re-challenged the whole /assets/ tree with nothing reporting it.
  const exempt = new Map<string, { path: string; op: 'eq' | 'pre' }>();
  for (const g of rule.conditionGroup)
    for (const c of g.conditions)
      if (c.type === 'path' && c.neg && typeof c.value === 'string') {
        const op = c.op === 'pre' ? 'pre' : 'eq';
        exempt.set(`${op}|${c.value}`, { path: c.value, op });
      }
  return {
    action:
      isRecoverableRule(rule.name) || action === 'challenge'
        ? 'challenge'
        : 'deny',
    exemptPaths: [...exempt.values()].map(denormalizeExempt),
  };
}

/** Rule with `value` added. Rejects a malformed one rather than shipping a condition that matches nothing, and de-duplicates so staging the same digest twice is a no-op. */
export function withValue(
  rule: Rule,
  spec: DenySpec,
  value: string,
): { rule: Rule; values: string[] } {
  const v = spec.normalize(value.trim());
  if (!spec.valid(v))
    throw new Error(`not ${spec.example} — refusing to add it to ${rule.name}`);
  const values = [...new Set([...valuesOf(rule, spec), v])];
  return {
    rule: denyListRule({
      name: rule.name,
      description: rule.description,
      spec,
      values,
      ...listShapeOf(rule),
    }),
    values,
  };
}

/** Rule with `value` removed. Removing the last entry yields the revocation placeholder, never an empty rule — an omitted rule keeps denying, unrevokably (applyRule is upsert-only). */
export function withoutValue(
  rule: Rule,
  spec: DenySpec,
  value: string,
): { rule: Rule; values: string[] } {
  const v = spec.normalize(value.trim());
  const values = valuesOf(rule, spec).filter((x) => x !== v);
  return {
    rule: denyListRule({
      name: rule.name,
      description: rule.description,
      spec,
      values,
      ...listShapeOf(rule),
    }),
    values,
  };
}

// Stripped before re-appending: withValue/withoutValue feed a rule's own description back in, so
// without this the counts compound into "… 1 denied. 2 denied."
const COUNT_SUFFIX =
  /\s*(?:\d+ (?:denied|challenged|listed)\.|REVOKED — nothing is (?:denied|challenged|listed)\.)$/;

/** Count-aware description, so the Vercel dashboard list says what a rule is doing without opening it. A revoked rule must say so loudly: it stays active and matching a placeholder, which otherwise reads as "denying something". Idempotent. */
export function denyDescription(
  base: string,
  count: number,
  verb: ListVerb = 'denied',
): string {
  const clean = base.replace(COUNT_SUFFIX, '');
  return count === 0
    ? `${clean} REVOKED — nothing is ${verb}.`
    : `${clean} ${count} ${verb}.`;
}

/**
 * Whether `value` is denied BY THE WAF right now, as opposed to in the local edit buffer. The
 * two staging states pull in opposite directions and both were wrong at some point: a staged
 * ADDITION has not been written, so it is not denied yet; a staged REMOVAL has not been written
 * either, so it still is. Reporting either backwards invites the operator to act twice.
 */
export function enforcedNow(
  live: string[],
  staged: string[],
  removed: string[],
  value: string,
  spec: DenySpec,
): boolean {
  const norm = (v: string) => spec.normalize(v.trim());
  const v = norm(value);
  if (!v) return false;
  if (staged.some((x) => norm(x) === v)) return false;
  return live.some((x) => norm(x) === v) || removed.some((x) => norm(x) === v);
}

/**
 * Unapplied edits to ONE deny rule, given the flat staged/removed lists the TUI keeps across both
 * denylists. `spec.valid` is the filter that matters: absence from this rule's live values is
 * otherwise indistinguishable from a removal staged against it, so lifting an ASN ban marked the
 * JA4 rule as having a pending removal too.
 */
export function pendingEdits(
  live: string[],
  staged: string[],
  removed: string[],
  spec: DenySpec,
): { added: number; dropped: number } {
  // Normalized on both sides: the TUI stages the value as typed, while the rule stores it
  // normalized, so an upper-case digest pasted from the dashboard counted as neither.
  const norm = (v: string) => spec.normalize(v.trim());
  const liveSet = new Set(live.map(norm));
  return {
    added: staged.filter((v) => liveSet.has(norm(v))).length,
    dropped: removed.filter((v) => spec.valid(norm(v)) && !liveSet.has(norm(v)))
      .length,
  };
}

/**
 * One condition group per value (Vercel ORs them). Revocation swaps in the placeholder, never
 * `active: false` (seedItems prefers the live flag) and never an omitted rule (applyRule is
 * upsert-only, so it would keep denying, unrevokable).
 */
/**
 * Paths a denied client may still read: the documents that TELL it why it is denied.
 *
 * Without this the refusal is unreachable. A crawler denied on every path can never fetch the
 * robots.txt naming it, so it cannot comply, cannot stop, and retries forever — and "we asked
 * them not to" is not true in any sense that matters. Voluntary compliance is cheaper than
 * enforcement for both sides, and it costs two small static files to make it possible.
 *
 * Deliberately NOT the sitemap. That is the corpus index, and handing it to a denied harvester
 * would be publishing the thing the denial exists to protect.
 */
export const POLICY_PATHS = ['/robots.txt', '/llms.txt'];

/**
 * A path a list rule must not act on. A bare string means an exact match, which is what the
 * policy documents need; the object form carries a prefix for whole trees.
 *
 * Widened rather than replacing the string form so `POLICY_PATHS` stays usable as raw paths
 * elsewhere, and so an `eq` exemption round-trips through `listShapeOf` unchanged.
 */
export type ExemptPath = string | { path: string; op: 'eq' | 'pre' };

/**
 * Paths where a CHALLENGE cannot be answered, so issuing one there is just a broken request.
 *
 * A challenge is an interstitial, and an interstitial can only present itself on a top-level
 * navigation. Everything below is fetched by the page or by the service worker with no user in
 * front of it: a 429 to a font, a hashed bundle, an analytics beacon or a map tile is an error
 * nobody can clear, and it breaks the app for someone who would happily have solved the challenge.
 *
 * Measured 2026-08-13: real browsers DO solve Vercel's challenge here — two UK users on Three and
 * BT met one and were through inside the same ten-minute bucket, then rendered 94 and 25
 * sub-resource requests. So the tier works where it can be answered, which is the argument for
 * confining it to where it can be.
 *
 * `/_serverFn/` is deliberately NOT here. It is a data surface worth protecting, and a browser
 * reaching it has already navigated and carries the clearance cookie, so the challenge costs it
 * nothing. `/sw.js` IS here: the service worker updates in the background with no user present.
 *
 * This weakens nothing against a harvester — it wants `/company/…`, which is a navigation and
 * stays covered.
 */
export const UNANSWERABLE_PATHS: ExemptPath[] = [
  { path: '/assets/', op: 'pre' }, // hashed bundles, also precached by the service worker
  { path: '/fonts/', op: 'pre' },
  { path: '/_vercel/', op: 'pre' }, // insights + speed-insights beacons
  { path: '/api/', op: 'pre' }, // map tiles and the rest of the XHR surface
  { path: '/sw.js', op: 'eq' },
  { path: '/manifest.json', op: 'eq' },
];

/** Exemptions in one shape, for emitting conditions. */
function normalizeExempt(e: ExemptPath): { path: string; op: 'eq' | 'pre' } {
  return typeof e === 'string' ? { path: e, op: 'eq' } : e;
}

/** And back, so an exact-match exemption round-trips as the plain string it came in as. */
function denormalizeExempt(e: { path: string; op: 'eq' | 'pre' }): ExemptPath {
  return e.op === 'eq' ? e.path : e;
}

/**
 * A list rule that CHALLENGES, for the tier an unattended writer may reach.
 *
 * Deliberately a separate builder taking no `action`, rather than an option on denyListRule. The
 * safety property is that nothing turns this list into a deny, and an option is exactly the kind
 * of thing a refactor or a merge drops in silence — a test asserting it would then still pass
 * against its own fixture. With no option there is nothing to drop.
 */
export function challengeListRule(
  opts: Omit<Parameters<typeof denyListRule>[0], 'action'>,
): Rule {
  return denyListRule({ ...opts, action: 'challenge' });
}

/**
 * The same description with its trailing count clause re-verbed for `action`.
 *
 * The verb used to be a fixed string; making it follow the action turned it into a claim, and a
 * rule cycled in the TUI then applied kept a description asserting the opposite of what it does —
 * "3 denied." on a rule that only interstitials. A no-op on any description without a count
 * clause, so rate-limit and allow rules pass through untouched.
 */
export function retitledForAction(
  description: string,
  action: Rule['action']['mitigate']['action'],
): string {
  // `log` gets its own verb rather than being left alone: a rule switched off kept announcing
  // "3 challenged" in the dashboard, which is a claim to be doing something it is not. "listed" is
  // the honest word for holding entries and acting on none of them.
  if (action !== 'deny' && action !== 'challenge' && action !== 'log')
    return description;
  const m = description.match(COUNT_SUFFIX);
  if (!m) return description;
  const verb: ListVerb =
    action === 'challenge'
      ? 'challenged'
      : action === 'log'
        ? 'listed'
        : 'denied';
  const count = m[0].match(/\d+/);
  return denyDescription(description, count ? Number(count[0]) : 0, verb);
}

export function denyListRule(opts: {
  name: string;
  description: string;
  spec: DenySpec;
  values: string[];
  /** Paths exempt from the deny, so the stated policy stays readable. */
  exemptPaths?: readonly ExemptPath[];
  /**
   * What the rule does on a match. `deny` unless a caller asks otherwise.
   *
   * `challenge` exists for the tier an unattended process is allowed to write to. A wrong deny
   * takes a real person offline silently and they cannot tell us; a wrong challenge costs them an
   * interstitial their browser solves, and is still fatal to a headless client. Same effect on the
   * target, far smaller cost when the judgement is wrong — which is the only thing that makes an
   * automated write defensible at all.
   */
  action?: ListAction;
}): Rule {
  if (!opts.spec.valid(opts.spec.placeholder))
    throw new Error(
      `${opts.name}: placeholder does not satisfy its own shape (expected ${opts.spec.example})`,
    );
  const values = opts.values.length ? opts.values : [opts.spec.placeholder];
  return {
    name: opts.name,
    description: denyDescription(
      opts.description,
      opts.values.length,
      (opts.action ?? 'deny') === 'challenge' ? 'challenged' : 'denied',
    ),
    active: true,
    // AND-ed within a group: matches the identity AND is not one of the policy documents. The
    // negation is what makes them readable — see POLICY_PATHS.
    conditionGroup: values.map((value) => ({
      conditions: [
        { type: opts.spec.type, op: opts.spec.op ?? 'eq', value },
        // The op is carried, not assumed. Emitting every exemption as `eq` would make a prefix
        // exemption match only the bare directory — so `/assets/` would be exempt and every file
        // under it still challenged, which is the failure this whole change exists to remove.
        ...(opts.exemptPaths ?? []).map((e): Condition => {
          const { path, op } = normalizeExempt(e);
          return { type: 'path', op, value: path, neg: true };
        }),
      ],
    })),
    action: { mitigate: { action: opts.action ?? 'deny' } },
  };
}
