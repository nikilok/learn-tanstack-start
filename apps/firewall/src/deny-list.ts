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
    description: opts.description,
    active: true,
    conditionGroup: values.map((value) => ({
      conditions: [{ type: opts.spec.type, op: 'eq' as const, value }],
    })),
    action: { mitigate: { action: 'deny' } },
  };
}
