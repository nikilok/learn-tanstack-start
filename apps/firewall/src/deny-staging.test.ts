// The deny edit buffer. Every value here is one keypress from taking real users offline, and the
// distinctions that matter are all between "in the local rule" and "live in the WAF".

import { describe, expect, test } from 'bun:test';

import {
  ASN_DENY,
  JA4_DENY,
  POLICY_PATHS,
  challengeListRule,
  denyListRule,
  valuesOf,
} from './deny-list';
import {
  ASN_RULE,
  JA4_RULE,
  afterStage,
  afterUnstage,
  denyEntries,
  enforcing,
  isStaged,
  liveDenies,
  pendingByRule,
  promotes,
  stage,
  unstage,
} from './deny-staging';
import { CHALLENGE_SCRAPER_JA4 } from './rule-names';
import type { Item } from './seed-items';

const DIGEST_A = 't13d1516h2_8daaf6152771_b0da82dd1658';
const DIGEST_B = 't13d1517h2_8daaf6152771_02713d6af862';
const AS_NUM = '14061'; // not 64512, which is the ASN placeholder valuesOf strips

function item(name: string, values: string[], over: Partial<Item> = {}): Item {
  const spec = name === ASN_RULE ? ASN_DENY : JA4_DENY;
  const challenge = name === CHALLENGE_SCRAPER_JA4;
  const build = challenge ? challengeListRule : denyListRule;
  return {
    rule: build({
      name,
      description: `${name}.`,
      spec,
      values,
      exemptPaths: POLICY_PATHS,
    }),
    active: true,
    action: challenge ? 'challenge' : 'deny',
    status: 'idle',
    ...over,
  };
}

const ja4Of = (items: Item[], name: string) =>
  valuesOf(items.find((it) => it.rule.name === name)!.rule, JA4_DENY);

describe('enforcing', () => {
  test('active and denying counts', () => {
    expect(enforcing(item(JA4_RULE, [DIGEST_A]))).toBe(true);
  });

  test('a deactivated rule does not, however many values it holds', () => {
    expect(enforcing(item(JA4_RULE, [DIGEST_A], { active: false }))).toBe(
      false,
    );
  });

  test('a rule cycled off deny does not — the traffic is still served', () => {
    for (const action of ['log', 'challenge', 'bypass'] as const)
      expect(enforcing(item(JA4_RULE, [DIGEST_A], { action }))).toBe(false);
  });

  test('a missing rule is not enforcing rather than a crash', () => {
    expect(enforcing(undefined)).toBe(false);
  });
});

describe('liveDenies', () => {
  test('reports what each rule is enforcing', () => {
    const live = liveDenies([
      item(JA4_RULE, [DIGEST_A]),
      item(ASN_RULE, [AS_NUM]),
    ]);
    expect(live.ja4).toEqual([DIGEST_A]);
    expect(live.asn).toEqual([AS_NUM]);
    expect(live.notEnforcing).toEqual([]);
  });

  test('a deactivated deny rule reports nothing live, and says why', () => {
    const live = liveDenies([item(JA4_RULE, [DIGEST_A], { active: false })]);
    expect(live.ja4).toEqual([]);
    expect(live.notEnforcing).toEqual([
      { rule: JA4_RULE, why: 'the rule is DEACTIVATED' },
    ]);
  });

  test('a deny rule cycled to log names the action that is serving the traffic', () => {
    const live = liveDenies([item(JA4_RULE, [DIGEST_A], { action: 'log' })]);
    expect(live.ja4).toEqual([]);
    expect(live.notEnforcing[0].why).toContain('its action is log, not deny');
  });

  test('an empty deny rule is not flagged — revoked is the resting state, not a fault', () => {
    expect(
      liveDenies([item(JA4_RULE, [], { active: false })]).notEnforcing,
    ).toEqual([]);
  });

  // `enforcing` requires action `deny`, which a challenge rule is never allowed to be. Reusing it
  // here read every live challenge as inert, and the advisory then treated our own suppressed
  // rendering as a measured zero.
  test('a live challenge tier is challenged, not inert', () => {
    const live = liveDenies([item(CHALLENGE_SCRAPER_JA4, [DIGEST_B])]);
    expect(live.challenged).toEqual([DIGEST_B]);
  });

  test('a deactivated challenge tier challenges nothing', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { active: false }),
    ]);
    expect(live.challenged).toEqual([]);
  });

  test('a challenge tier cycled to log challenges nothing', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { action: 'log' }),
    ]);
    expect(live.challenged).toEqual([]);
  });

  test('but its VALUES survive being switched off — that is what a promotion reads', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { active: false }),
    ]);
    expect(live.challenged).toEqual([]);
    expect(live.challengeValues).toEqual([DIGEST_B]);
  });

  // A challenge tier holding digests while switched off is protection that is not there.
  test('a deactivated challenge tier holding digests is reported as not enforcing', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { active: false }),
    ]);
    expect(live.notEnforcing).toEqual([
      { rule: CHALLENGE_SCRAPER_JA4, why: 'the rule is DEACTIVATED' },
    ]);
  });

  test('a challenge tier cycled to log says which action is serving the traffic', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { action: 'log' }),
    ]);
    expect(live.notEnforcing[0].why).toContain('its action is log');
  });

  test('the challenge tier is told it is not CHALLENGING, not "not deny"', () => {
    const live = liveDenies([
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_B], { action: 'log' }),
    ]);
    expect(live.notEnforcing[0].why).toContain('not challenge');
    expect(live.notEnforcing[0].why).not.toContain('not deny');
  });

  test('a live challenge tier is NOT reported as not enforcing', () => {
    expect(
      liveDenies([item(CHALLENGE_SCRAPER_JA4, [DIGEST_B])]).notEnforcing,
    ).toEqual([]);
  });

  test('a config with none of the rules yields empty lists, not a throw', () => {
    expect(liveDenies([])).toEqual({
      ja4: [],
      asn: [],
      challenged: [],
      challengeValues: [],
      notEnforcing: [],
    });
  });
});

// The dialog says "PROMOTE" or "Deny", and it must describe the edit that is about to happen.
describe('promotes', () => {
  test('a digest on the challenge list promotes', () => {
    expect(promotes([DIGEST_B], DIGEST_B)).toBe(true);
  });

  test('a digest that is not on it does not', () => {
    expect(promotes([DIGEST_B], DIGEST_A)).toBe(false);
  });

  test('case is normalized — dashboards render hashes upper-case', () => {
    expect(promotes([DIGEST_B], DIGEST_B.toUpperCase())).toBe(true);
  });

  test('an empty target never promotes', () => {
    expect(promotes([DIGEST_B], '')).toBe(false);
    expect(promotes([DIGEST_B], '   ')).toBe(false);
  });
});

describe('stage', () => {
  test('adds the value to its own deny rule', () => {
    const { items, error } = stage([item(JA4_RULE, [])], 'ja4', DIGEST_A);
    expect(error).toBeUndefined();
    expect(ja4Of(items, JA4_RULE)).toEqual([DIGEST_A]);
  });

  test('an ASN goes to the ASN rule', () => {
    const items = [item(JA4_RULE, []), item(ASN_RULE, [])];
    const out = stage(items, 'asn', AS_NUM);
    expect(valuesOf(out.items[1].rule, ASN_DENY)).toEqual([AS_NUM]);
    expect(ja4Of(out.items, JA4_RULE)).toEqual([]);
  });

  // A throw inside a setItems updater escapes the keypress handler with no error boundary and
  // every deny staged this session dies with the process.
  test('a malformed value is refused as a returned error, never a throw', () => {
    const items = [item(JA4_RULE, [])];
    const out = stage(items, 'ja4', 'not-a-digest');
    expect(out.error).toContain('refused');
    expect(out.items).toBe(items);
  });

  test('a malformed AS number is refused too', () => {
    expect(stage([item(ASN_RULE, [])], 'asn', 'AS14061').error).toContain(
      'refused',
    );
  });

  test('staging clears the row status, so an edited rule is visibly unapplied', () => {
    const items = [item(JA4_RULE, [], { status: 'overwrote', detail: 'ok' })];
    const { items: next } = stage(items, 'ja4', DIGEST_A);
    expect(next[0].status).toBe('idle');
    expect(next[0].detail).toBeUndefined();
  });

  // The policy-document exemption was dropped once by a rebuild, so the next apply removed it
  // from the live WAF with nothing reporting a change.
  test('the rebuilt rule keeps its path exemptions', () => {
    const { items } = stage([item(JA4_RULE, [])], 'ja4', DIGEST_A);
    const paths = items[0].rule.conditionGroup
      .flatMap((g) => g.conditions)
      .filter((c) => c.type === 'path')
      .map((c) => c.value);
    for (const p of POLICY_PATHS) expect(paths).toContain(p);
  });

  test('staging the same digest twice is a no-op, not a duplicate', () => {
    const once = stage([item(JA4_RULE, [])], 'ja4', DIGEST_A).items;
    const twice = stage(once, 'ja4', DIGEST_A).items;
    expect(ja4Of(twice, JA4_RULE)).toEqual([DIGEST_A]);
  });

  // The promotion. The two lists are alternatives, not layers.
  test('a JA4 deny drops the digest from the challenge tier in the same edit', () => {
    const items = [
      item(JA4_RULE, []),
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_A, DIGEST_B]),
    ];
    const { items: next } = stage(items, 'ja4', DIGEST_A);
    expect(ja4Of(next, JA4_RULE)).toEqual([DIGEST_A]);
    expect(ja4Of(next, CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST_B]);
  });

  test('it promotes off an INERT challenge tier too, not just a live one', () => {
    // Gating this on liveness would leave the digest on a list the next apply re-activates.
    const items = [
      item(JA4_RULE, []),
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_A], { active: false }),
    ];
    const { items: next } = stage(items, 'ja4', DIGEST_A);
    expect(ja4Of(next, CHALLENGE_SCRAPER_JA4)).toEqual([]);
  });

  test('the challenge tier stays a challenge rule after the promotion', () => {
    // Rebuilding it as a deny would escalate a whole tier with no action keypress at all.
    const items = [item(JA4_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_A])];
    const { items: next } = stage(items, 'ja4', DIGEST_A);
    const challenge = next.find(
      (it) => it.rule.name === CHALLENGE_SCRAPER_JA4,
    )!;
    expect(challenge.rule.action.mitigate.action).toBe('challenge');
  });

  test('an ASN deny leaves the challenge tier alone', () => {
    const items = [item(ASN_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_A])];
    const { items: next } = stage(items, 'asn', AS_NUM);
    expect(ja4Of(next, CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST_A]);
  });

  test('unrelated rules are untouched', () => {
    const other = item('allow-something', []);
    const { items } = stage([other, item(JA4_RULE, [])], 'ja4', DIGEST_A);
    expect(items[0]).toBe(other);
  });
});

describe('unstage', () => {
  test('removes the value from its rule', () => {
    const items = unstage(
      [item(JA4_RULE, [DIGEST_A, DIGEST_B])],
      'ja4',
      DIGEST_A,
    );
    expect(ja4Of(items, JA4_RULE)).toEqual([DIGEST_B]);
  });

  test('removing the last entry leaves a revoked rule, never an empty one', () => {
    // An omitted rule keeps denying, unrevokably — applyRule is upsert-only.
    const items = unstage([item(JA4_RULE, [DIGEST_A])], 'ja4', DIGEST_A);
    expect(ja4Of(items, JA4_RULE)).toEqual([]);
    expect(items[0].rule.conditionGroup.length).toBeGreaterThan(0);
  });

  test('clears the row status like any other edit', () => {
    const items = unstage(
      [item(JA4_RULE, [DIGEST_A], { status: 'overwrote' })],
      'ja4',
      DIGEST_A,
    );
    expect(items[0].status).toBe('idle');
  });
});

// Promote, then think better of it. Without the restore the digest ends up on NEITHER list, so
// the operator is left with LESS protection than before they pressed b — and nothing says so.
describe('lifting a promotion', () => {
  const promoted = () => {
    const items = [item(JA4_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_A])];
    return stage(items, 'ja4', DIGEST_A).items;
  };

  test('the digest goes back to the challenge tier it was taken from', () => {
    const after = unstage(promoted(), 'ja4', DIGEST_A, true);
    expect(ja4Of(after, JA4_RULE)).toEqual([]);
    expect(ja4Of(after, CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST_A]);
  });

  test('the restored rule is still a CHALLENGE rule, not rebuilt as a deny', () => {
    const after = unstage(promoted(), 'ja4', DIGEST_A, true);
    const challenge = after.find(
      (it) => it.rule.name === CHALLENGE_SCRAPER_JA4,
    )!;
    expect(challenge.rule.action.mitigate.action).toBe('challenge');
  });

  test('a deny that was NOT a promotion restores nothing', () => {
    const items = [item(JA4_RULE, [DIGEST_A]), item(CHALLENGE_SCRAPER_JA4, [])];
    const after = unstage(items, 'ja4', DIGEST_A);
    expect(ja4Of(after, CHALLENGE_SCRAPER_JA4)).toEqual([]);
  });

  test('an ASN lift never touches the challenge tier', () => {
    const items = [
      item(ASN_RULE, [AS_NUM]),
      item(CHALLENGE_SCRAPER_JA4, [DIGEST_A]),
    ];
    const after = unstage(items, 'asn', AS_NUM, true);
    expect(ja4Of(after, CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST_A]);
  });
});

describe('afterStage / afterUnstage', () => {
  test('staging records the value and cancels any pending removal of it', () => {
    expect(afterStage([], [DIGEST_A], DIGEST_A)).toEqual({
      staged: [DIGEST_A],
      removed: [],
    });
  });

  test('staging twice does not duplicate', () => {
    expect(afterStage([DIGEST_A], [], DIGEST_A).staged).toEqual([DIGEST_A]);
  });

  test('lifting a LIVE deny records a removal, so it is applied', () => {
    expect(afterUnstage([], [], { value: DIGEST_A, staged: false })).toEqual({
      staged: [],
      removed: [DIGEST_A],
    });
  });

  // Recording it as a removal invents an unban of something that was never denied, and
  // pendingEdits then counts it against the rule.
  test('undoing a STAGED addition just drops the stage', () => {
    expect(
      afterUnstage([DIGEST_A], [], { value: DIGEST_A, staged: true }),
    ).toEqual({ staged: [], removed: [] });
  });

  // Found in review 2026-08-13. The lists were compared with raw equality while everything that
  // reads them normalizes, so a digest staged upper-case could never be matched again: lifting it
  // left a phantom entry staged forever, and the advisory read the identity as never touched.
  describe('case', () => {
    const UPPER = DIGEST_A.toUpperCase();

    test('a value staged upper-case is held normalized', () => {
      expect(afterStage([], [], UPPER).staged).toEqual([DIGEST_A]);
    });

    test('staging the same digest in both cases is ONE entry', () => {
      const once = afterStage([], [], DIGEST_A);
      expect(afterStage(once.staged, once.removed, UPPER).staged).toEqual([
        DIGEST_A,
      ]);
    });

    test('lifting removes a digest that was staged in the other case', () => {
      const staged = afterStage([], [], UPPER).staged;
      expect(
        afterUnstage(staged, [], { value: DIGEST_A, staged: true }).staged,
      ).toEqual([]);
    });

    test('staging cancels a pending removal recorded in the other case', () => {
      const lifted = afterUnstage([], [], { value: UPPER, staged: false });
      expect(lifted.removed).toEqual([DIGEST_A]);
      expect(afterStage([], lifted.removed, DIGEST_A).removed).toEqual([]);
    });

    test('a lifted value is recorded normalized', () => {
      expect(
        afterUnstage([], [], { value: UPPER, staged: false }).removed,
      ).toEqual([DIGEST_A]);
    });

    test('an AS number is untouched — the normalization must be safe for both lists', () => {
      expect(afterStage([], [], AS_NUM).staged).toEqual([AS_NUM]);
      expect(
        afterUnstage([], [], { value: AS_NUM, staged: false }).removed,
      ).toEqual([AS_NUM]);
    });

    test('surrounding whitespace never creates a second entry', () => {
      expect(afterStage([DIGEST_A], [], ` ${DIGEST_A} `).staged).toEqual([
        DIGEST_A,
      ]);
    });
  });
});

// The advisory asks this about the digest on screen, which is normalized; the list holds what was
// typed. An exact `includes` reported a digest staged upper-case as unstaged.
describe('isStaged', () => {
  test('finds a staged value', () => {
    expect(isStaged([DIGEST_A], DIGEST_A)).toBe(true);
  });

  test('finds it whatever case the caller asks in', () => {
    expect(isStaged([DIGEST_A], DIGEST_A.toUpperCase())).toBe(true);
  });

  test('finds one staged upper-case, because the list normalizes on the way in', () => {
    const staged = afterStage([], [], DIGEST_A.toUpperCase()).staged;
    expect(isStaged(staged, DIGEST_A)).toBe(true);
  });

  test('does not find a value that was never staged', () => {
    expect(isStaged([DIGEST_A], DIGEST_B)).toBe(false);
    expect(isStaged([], DIGEST_A)).toBe(false);
  });
});

describe('denyEntries', () => {
  const base = {
    liveJa4: [] as string[],
    liveAsn: [] as string[],
    staged: [] as string[],
    removed: [] as string[],
    activity: null,
  };

  test('a live value with no staging reads as live', () => {
    const [e] = denyEntries({ ...base, liveJa4: [DIGEST_A] });
    expect(e).toMatchObject({
      kind: 'ja4',
      value: DIGEST_A,
      staged: false,
      removed: false,
    });
  });

  // A raw `includes` rendered a staged deny as `live` and hid the "press a to apply" banner.
  test('a staged value is marked staged even when it was typed upper-case', () => {
    const [e] = denyEntries({
      ...base,
      liveJa4: [DIGEST_A],
      staged: [DIGEST_A.toUpperCase()],
    });
    expect(e.staged).toBe(true);
  });

  // The rule is deactivated, so liveDenies reports nothing for it — and the staged edit used to
  // disappear with it, leaving the operator staring at a pane that denied their own edit existed.
  test('a value staged onto a NON-enforcing rule is still shown as staged', () => {
    const [e] = denyEntries({ ...base, staged: [DIGEST_A] });
    expect(e).toMatchObject({ kind: 'ja4', value: DIGEST_A, staged: true });
  });

  test('a staged ASN on a non-enforcing rule is classified by shape', () => {
    const [e] = denyEntries({ ...base, staged: [AS_NUM] });
    expect(e.kind).toBe('asn');
  });

  test('a staged value already live is not listed twice', () => {
    const out = denyEntries({
      ...base,
      liveJa4: [DIGEST_A],
      staged: [DIGEST_A],
    });
    expect(out).toHaveLength(1);
    expect(out[0].staged).toBe(true);
  });

  test('a lifted value is listed as removed', () => {
    const [e] = denyEntries({ ...base, removed: [DIGEST_A] });
    expect(e).toMatchObject({ value: DIGEST_A, removed: true, staged: false });
  });

  test('the shared removal list is split back by SHAPE, not by a substring guess', () => {
    const out = denyEntries({ ...base, removed: [DIGEST_A, AS_NUM] });
    expect(out.map((e) => e.kind)).toEqual(['ja4', 'asn']);
  });

  test('activity counts are attached when the lookup covered the value', () => {
    const [e] = denyEntries({
      ...base,
      liveJa4: [DIGEST_A],
      activity: new Map([[DIGEST_A, { requests: 40, denied: 39 }]]),
    });
    expect(e.requests).toBe(40);
    expect(e.denied).toBe(39);
  });

  // fetchDenyActivity stores its keys normalized; a removal entry keeps whatever was typed.
  test('activity is found for a removal entry recorded upper-case', () => {
    const [e] = denyEntries({
      ...base,
      removed: [DIGEST_A.toUpperCase()],
      activity: new Map([[DIGEST_A, { requests: 12, denied: 12 }]]),
    });
    expect(e.requests).toBe(12);
  });

  test('a value the lookup missed stays undefined, never zero', () => {
    // Zero reads as "safe to retire" about a ban still doing work.
    const [e] = denyEntries({
      ...base,
      liveJa4: [DIGEST_A],
      activity: new Map(),
    });
    expect(e.requests).toBeUndefined();
    expect(e.denied).toBeUndefined();
  });
});

describe('pendingByRule', () => {
  test('nothing staged marks nothing', () => {
    expect(pendingByRule([item(JA4_RULE, [DIGEST_A])], [], []).size).toBe(0);
  });

  test('a staged addition marks its rule', () => {
    const { items } = stage([item(JA4_RULE, [])], 'ja4', DIGEST_A);
    expect(pendingByRule(items, [DIGEST_A], []).get(JA4_RULE)).toBe('+1');
  });

  test('a pending removal marks its rule', () => {
    const items = unstage([item(JA4_RULE, [DIGEST_A])], 'ja4', DIGEST_A);
    expect(pendingByRule(items, [], [DIGEST_A]).get(JA4_RULE)).toBe('−1');
  });

  // Absence from a rule's live values is otherwise indistinguishable from a removal staged
  // against it, so lifting an ASN ban marked the JA4 rule as having a pending removal too.
  test('lifting an ASN ban does not mark the JA4 rule', () => {
    const items = [item(JA4_RULE, [DIGEST_A]), item(ASN_RULE, [])];
    const pending = pendingByRule(items, [], [AS_NUM]);
    expect(pending.has(JA4_RULE)).toBe(false);
    expect(pending.get(ASN_RULE)).toBe('−1');
  });

  // A promotion takes the digest off the challenge rule without it ever reaching `removed`, so
  // pendingEdits sees nothing on either side and the row looked inert while carrying an edit.
  test('a promotion marks the challenge rule, which nothing else can see', () => {
    const items = [item(JA4_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_A])];
    const out = stage(items, 'ja4', DIGEST_A);
    expect(out.promoted).toBe(DIGEST_A);
    const pending = pendingByRule(out.items, [DIGEST_A], [], [DIGEST_A]);
    expect(pending.get(CHALLENGE_SCRAPER_JA4)).toBe('−1');
    expect(pending.get(JA4_RULE)).toBe('+1');
  });

  test('staging a digest that was NOT challenged promotes nothing', () => {
    const items = [item(JA4_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_B])];
    const out = stage(items, 'ja4', DIGEST_A);
    expect(out.promoted).toBeUndefined();
    expect(
      pendingByRule(out.items, [DIGEST_A], [], []).has(CHALLENGE_SCRAPER_JA4),
    ).toBe(false);
  });

  test('an ASN stage never promotes', () => {
    const items = [item(ASN_RULE, []), item(CHALLENGE_SCRAPER_JA4, [DIGEST_A])];
    expect(stage(items, 'asn', AS_NUM).promoted).toBeUndefined();
  });

  test('an addition and a removal on one rule are shown together', () => {
    let items = stage([item(JA4_RULE, [DIGEST_B])], 'ja4', DIGEST_A).items;
    items = unstage(items, 'ja4', DIGEST_B);
    expect(pendingByRule(items, [DIGEST_A], [DIGEST_B]).get(JA4_RULE)).toBe(
      '+1 −1',
    );
  });
});
