// The rules are rebuilt from .env.local on every apply, so a deny that reaches the WAF and not
// the file is lifted by the next run. Everything here is about that one asymmetry.

import { describe, expect, test } from 'bun:test';

import {
  ASN_DENY,
  JA4_DENY,
  POLICY_PATHS,
  challengeListRule,
  denyListRule,
} from './deny-list';
import { PERSIST_TARGETS, persistDenies } from './deny-persist';
import { ASN_RULE, JA4_RULE } from './deny-staging';
import { CHALLENGE_SCRAPER_JA4 } from './rule-names';
import type { ApplyStatus, Item } from './seed-items';

const DIGEST_A = 't13d1516h2_8daaf6152771_b0da82dd1658';
const DIGEST_B = 't13d1517h2_8daaf6152771_02713d6af862';
// A real hosting ASN. Deliberately not 64512, which IS the ASN placeholder valuesOf strips.
const AS_NUM = '14061';

function item(
  name: string,
  values: string[],
  opts: { challenge?: boolean } = {},
): Item {
  const spec = name === ASN_RULE ? ASN_DENY : JA4_DENY;
  const build = opts.challenge ? challengeListRule : denyListRule;
  return {
    rule: build({
      name,
      description: `${name}.`,
      spec,
      values,
      exemptPaths: POLICY_PATHS,
    }),
    active: true,
    action: opts.challenge ? 'challenge' : 'deny',
    status: 'idle',
  };
}

/** A full apply where every listed rule reported `status`. */
const allReached = (snapshot: Item[], status: ApplyStatus = 'overwrote') =>
  new Map(snapshot.map((it) => [it.rule.name, status]));

function run(
  snapshot: Item[],
  outcome: Map<string, ApplyStatus>,
  over: { pending?: boolean; dryRun?: boolean; failOn?: string } = {},
) {
  const writes: [string, string][] = [];
  const result = persistDenies({
    snapshot,
    outcome,
    pending: over.pending ?? true,
    dryRun: over.dryRun ?? false,
    write: (envKey, value) => {
      if (over.failOn === envKey) throw new Error('EACCES: read-only file');
      writes.push([envKey, value]);
    },
  });
  return { result, writes, wrote: new Map(writes) };
}

describe('PERSIST_TARGETS', () => {
  test('every rule writes its OWN env var', () => {
    // A crossed label writes one list into the other's var, which un-bans everything on both.
    expect(PERSIST_TARGETS.map((t) => [t.rule, t.envKey])).toEqual([
      [JA4_RULE, 'FW_BLOCKED_JA4'],
      [ASN_RULE, 'FW_BLOCKED_ASN'],
      [CHALLENGE_SCRAPER_JA4, 'FW_CHALLENGE_JA4'],
    ]);
  });

  test('each env var appears exactly once, so no target overwrites another', () => {
    const keys = PERSIST_TARGETS.map((t) => t.envKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the challenge tier is persisted, because a deny promotes off it', () => {
    expect(PERSIST_TARGETS.some((t) => t.rule === CHALLENGE_SCRAPER_JA4)).toBe(
      true,
    );
  });
});

describe('persistDenies', () => {
  test('nothing staged writes nothing and says nothing', () => {
    const snapshot = [item(JA4_RULE, [DIGEST_A])];
    const { result, writes } = run(snapshot, allReached(snapshot), {
      pending: false,
    });
    expect(writes).toEqual([]);
    expect(result).toEqual({ ok: true, summary: '', clearStaged: false });
  });

  test('a dry run reaches no WAF, so it must not write the file either', () => {
    // Writing here would enforce or lift a ban the operator only previewed.
    const snapshot = [item(JA4_RULE, [DIGEST_A])];
    const { result, writes } = run(snapshot, allReached(snapshot), {
      dryRun: true,
    });
    expect(writes).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.clearStaged).toBe(false);
    expect(result.summary).toContain('NOT written');
  });

  test('a successful apply writes each list and clears the staging', () => {
    const snapshot = [
      item(JA4_RULE, [DIGEST_A]),
      item(ASN_RULE, [AS_NUM]),
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { challenge: true }),
    ];
    const { result, wrote } = run(snapshot, allReached(snapshot));
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(DIGEST_A);
    expect(wrote.get('FW_BLOCKED_ASN')).toBe(AS_NUM);
    expect(wrote.get('FW_CHALLENGE_JA4')).toBe(DIGEST_B);
    expect(result).toEqual({
      ok: true,
      summary: ' · denylist saved to .env.local',
      clearStaged: true,
    });
  });

  // The promote-persist trap, 2026-08-13. Denying a challenged digest drops it from the challenge
  // rule in the same edit; persisting only the deny leaves FW_CHALLENGE_JA4 stale, and the next
  // apply rebuilds the challenge list from it and puts the digest back on BOTH lists.
  test('promoting writes the challenge list too, so the removal is not lost', () => {
    const snapshot = [
      item(JA4_RULE, [DIGEST_A]), // promoted in
      item(CHALLENGE_SCRAPER_JA4, [], { challenge: true }), // and off here
    ];
    const { wrote } = run(snapshot, allReached(snapshot));
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(DIGEST_A);
    expect(wrote.has('FW_CHALLENGE_JA4')).toBe(true);
    expect(wrote.get('FW_CHALLENGE_JA4')).toBe('');
  });

  test('an emptied list writes an empty value, never a skipped key', () => {
    // A skipped key leaves the old value in the file, so the next apply re-bans what was lifted.
    const snapshot = [item(JA4_RULE, [])];
    const { wrote } = run(snapshot, allReached(snapshot));
    expect(wrote.get('FW_BLOCKED_JA4')).toBe('');
  });

  test('several values round-trip as the comma-separated list env expects', () => {
    const snapshot = [item(JA4_RULE, [DIGEST_A, DIGEST_B])];
    const { wrote } = run(snapshot, allReached(snapshot));
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(`${DIGEST_A},${DIGEST_B}`);
  });

  test('a rule that failed to apply is NOT written, and the run fails', () => {
    // Writing it would record a ban the WAF never took, which the next apply then enforces.
    const snapshot = [item(JA4_RULE, [DIGEST_A]), item(ASN_RULE, [AS_NUM])];
    const outcome = allReached(snapshot);
    outcome.set(JA4_RULE, 'error');
    const { result, wrote } = run(snapshot, outcome);
    expect(wrote.has('FW_BLOCKED_JA4')).toBe(false);
    expect(wrote.get('FW_BLOCKED_ASN')).toBe(AS_NUM);
    expect(result.ok).toBe(false);
    expect(result.clearStaged).toBe(false);
    expect(result.summary).toContain('FW_BLOCKED_JA4 NOT saved');
  });

  // A quit mid-apply breaks out before the later rules, so `outcome` holds one and not the other.
  test('a rule never reached leaves the staging intact rather than half-clearing it', () => {
    const snapshot = [item(JA4_RULE, [DIGEST_A]), item(ASN_RULE, [AS_NUM])];
    const outcome = new Map<string, ApplyStatus>([[JA4_RULE, 'overwrote']]);
    const { result, wrote } = run(snapshot, outcome);
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(DIGEST_A);
    expect(result.clearStaged).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('never reached');
  });

  test('a file that cannot be written fails the run and names the var', () => {
    const snapshot = [item(JA4_RULE, [DIGEST_A])];
    const { result } = run(snapshot, allReached(snapshot), {
      failOn: 'FW_BLOCKED_JA4',
    });
    expect(result.ok).toBe(false);
    expect(result.clearStaged).toBe(false);
    expect(result.summary).toContain('FW_BLOCKED_JA4 NOT saved');
    expect(result.summary).toContain('the next apply will undo it');
  });

  test('one failed write does not clear the staging the others persisted', () => {
    const snapshot = [
      item(JA4_RULE, [DIGEST_A]),
      item(ASN_RULE, [AS_NUM]),
      item(CHALLENGE_SCRAPER_JA4, [], { challenge: true }),
    ];
    const { result, wrote } = run(snapshot, allReached(snapshot), {
      failOn: 'FW_CHALLENGE_JA4',
    });
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(DIGEST_A);
    expect(result.clearStaged).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('a rule absent from the config is skipped, not treated as unreached', () => {
    // Only the JA4 rule is in play; the others simply do not exist in this config.
    const snapshot = [item(JA4_RULE, [DIGEST_A])];
    const { result, wrote } = run(snapshot, allReached(snapshot));
    expect(wrote.size).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.clearStaged).toBe(true);
    expect(result.summary).not.toContain('never reached');
  });

  // The vacuous-pass class: edits pending, nothing matched, nothing written, and the run used to
  // report ok with an empty summary — persisting none of it while looking clean.
  test('pending edits with no deny rule at all is reported, not silently ok', () => {
    const { result, writes } = run([], new Map());
    expect(writes).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.clearStaged).toBe(false);
    expect(result.summary).toContain('nothing was saved');
  });

  test('an inserted rule persists exactly like an overwritten one', () => {
    const snapshot = [item(JA4_RULE, [DIGEST_A])];
    const { result, wrote } = run(snapshot, allReached(snapshot, 'inserted'));
    expect(wrote.get('FW_BLOCKED_JA4')).toBe(DIGEST_A);
    expect(result.ok).toBe(true);
  });
});
