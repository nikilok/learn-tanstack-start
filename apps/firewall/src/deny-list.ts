// Env-driven identity denylists. Never put a value in an error or log line: --apply output is public.

import type { Rule } from './rules';

// Narrower than Condition['type']: header/query need a `key` this factory never forwards.
export type DenyType = 'ja4_digest' | 'geo_as_number';

export type DenySpec = {
  type: DenyType;
  valid: (v: string) => boolean;
  normalize: (v: string) => string;
  example: string; // describes the shape; never paste-able, or the error becomes a match-nothing template
  placeholder: string; // valid, unmatchable; asserted against `valid` in denyListRule
};

const MAX_ASN = 4_294_967_295;

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
  return rule.conditionGroup
    .flatMap((g) => g.conditions.map((c) => c.value))
    .filter((v): v is string => typeof v === 'string')
    .filter((v) => v !== spec.placeholder);
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
    }),
    values,
  };
}

// Stripped before re-appending: withValue/withoutValue feed a rule's own description back in, so
// without this the counts compound into "… 1 denied. 2 denied."
const COUNT_SUFFIX = /\s*(?:\d+ denied\.|REVOKED — nothing is denied\.)$/;

/** Count-aware description, so the Vercel dashboard list says what a rule is doing without opening it. A revoked rule must say so loudly: it stays active and matching a placeholder, which otherwise reads as "denying something". Idempotent. */
export function denyDescription(base: string, count: number): string {
  const clean = base.replace(COUNT_SUFFIX, '');
  return count === 0
    ? `${clean} REVOKED — nothing is denied.`
    : `${clean} ${count} denied.`;
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
export function denyListRule(opts: {
  name: string;
  description: string;
  spec: DenySpec;
  values: string[];
}): Rule {
  if (!opts.spec.valid(opts.spec.placeholder))
    throw new Error(
      `${opts.name}: placeholder does not satisfy its own shape (expected ${opts.spec.example})`,
    );
  const values = opts.values.length ? opts.values : [opts.spec.placeholder];
  return {
    name: opts.name,
    description: denyDescription(opts.description, opts.values.length),
    active: true,
    conditionGroup: values.map((value) => ({
      conditions: [{ type: opts.spec.type, op: 'eq' as const, value }],
    })),
    action: { mitigate: { action: 'deny' } },
  };
}
