// The deny edit buffer, driven through the hook rather than through its pure parts.
//
// Those parts each had tests and the hook wiring them together had none, which is exactly where
// this refactor kept putting its defects: a value staged but never marked, a promotion with no
// undo, a predicate reading an un-normalized list.

import { describe, expect, test } from 'bun:test';

import { Text } from 'ink';
import { useEffect, useState } from 'react';

import {
  ASN_DENY,
  JA4_DENY,
  POLICY_PATHS,
  challengeListRule,
  denyListRule,
  valuesOf,
} from '../deny-list';
import { ASN_RULE, JA4_RULE } from '../deny-staging';
import { renderInk } from '../ink-harness';
import { CHALLENGE_SCRAPER_JA4 } from '../rule-names';
import type { ApplyStatus, Item } from '../seed-items';
import { type Denylist, useDenylist } from './useDenylist';

const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';
const OTHER = 't13d1517h2_8daaf6152771_02713d6af862';
const AS_NUM = '14061';

function item(name: string, values: string[]): Item {
  const challenge = name === CHALLENGE_SCRAPER_JA4;
  return {
    rule: (challenge ? challengeListRule : denyListRule)({
      name,
      description: `${name}.`,
      spec: name === ASN_RULE ? ASN_DENY : JA4_DENY,
      values,
      exemptPaths: POLICY_PATHS,
    }),
    active: true,
    action: challenge ? 'challenge' : 'deny',
    status: 'idle',
  };
}

/** Mount the hook over a real items state, and hand both back. */
async function mount(initial: Item[]) {
  const writes: [string, string][] = [];
  let api!: Denylist;
  let items: Item[] = initial;
  let edits = 0;

  function Probe() {
    const [rows, setRows] = useState(initial);
    const deny = useDenylist({
      items: rows,
      setItems: setRows as never,
      onEdit: () => {
        edits += 1;
      },
      writeEnv: (k, v) => writes.push([k, v]),
    });
    useEffect(() => {
      api = deny;
      items = rows;
    });
    return (
      <Text>
        entries=
        {deny.entries
          .map(
            (e) => `${e.value}:${e.staged ? 's' : ''}${e.removed ? 'r' : ''}`,
          )
          .join(' ')}
        {' | '}pending=
        {[...deny.pending].map(([r, m]) => `${r}=${m}`).join(' ')}
        {' | '}cursor={deny.cursor}
      </Text>
    );
  }

  const h = renderInk(<Probe />, { columns: 200 });
  await h.settle();
  return {
    h,
    get: () => api,
    items: () => items,
    writes,
    edits: () => edits,
    ja4Of: (name: string) =>
      valuesOf(items.find((i) => i.rule.name === name)!.rule, JA4_DENY),
  };
}

describe('useDenylist', () => {
  test('a live deny is listed', async () => {
    const t = await mount([item(JA4_RULE, [DIGEST])]);
    expect(t.h.frame()).toContain(`${DIGEST}:`);
    t.h.unmount();
  });

  describe('staging', () => {
    test('a staged deny reaches the rule, the entries and the pending marker', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      expect(t.get().stageDeny('ja4', DIGEST)).toBeUndefined();
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE)).toEqual([DIGEST]);
      expect(t.h.frame()).toContain(`${DIGEST}:s`);
      expect(t.h.frame()).toContain(`${JA4_RULE}=+1`);
      t.h.unmount();
    });

    // Both edits computed from the render-time items, so the second started from a snapshot
    // taken before the first and overwrote it. The pane showed the lost deny as staged while the
    // rule never carried it, and the apply wrote a list missing one of them.
    test('two denies staged in ONE tick both reach the rule', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      t.get().stageDeny('ja4', OTHER);
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE).sort()).toEqual([DIGEST, OTHER].sort());
      t.h.unmount();
    });

    test('a lift straight after a stage does not resurrect the staged value', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST])]);
      t.get().stageDeny('ja4', OTHER);
      t.get().unstageDeny(t.get().entries[0]);
      await t.h.settle();
      // OTHER was added and DIGEST lifted — both edits survive, in order.
      expect(t.ja4Of(JA4_RULE)).toEqual([OTHER]);
      t.h.unmount();
    });

    test('a refused value returns the message and changes nothing', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      expect(t.get().stageDeny('ja4', 'nonsense')).toContain('refused');
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE)).toEqual([]);
      expect(t.edits()).toBe(0);
      t.h.unmount();
    });

    test('an edit clears the last apply banner', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      expect(t.edits()).toBe(1);
      t.h.unmount();
    });
  });

  // staged and removed were updated by two setters that each read the OTHER from the render-time
  // closure. Lift a live deny and re-deny it before a render and the rule comes back to where it
  // started, but the value stays on `staged` — so `pending` is true and the apply treats a
  // cancelled edit as work to persist.
  describe('an edit and its reversal in one tick', () => {
    test('lifting then re-denying leaves nothing pending', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST])]);
      t.get().unstageDeny(t.get().entries[0]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      // Back where it started: the rule still denies it...
      expect(t.ja4Of(JA4_RULE)).toEqual([DIGEST]);
      // ...and nothing is left marked as an unapplied change.
      expect(t.h.frame()).toContain('pending= |');
      t.h.unmount();
    });

    test('denying then lifting the same value also settles', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      t.get().unstageDeny(t.get().entries[0]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE)).toEqual([DIGEST]);
      t.h.unmount();
    });
  });

  describe('promotion', () => {
    const withChallenge = () => [
      item(JA4_RULE, []),
      item(CHALLENGE_SCRAPER_JA4, [DIGEST]),
    ];

    test('denying a challenged digest moves it, and marks BOTH rules', async () => {
      const t = await mount(withChallenge());
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE)).toEqual([DIGEST]);
      expect(t.ja4Of(CHALLENGE_SCRAPER_JA4)).toEqual([]);
      expect(t.h.frame()).toContain(`${JA4_RULE}=+1`);
      expect(t.h.frame()).toContain(`${CHALLENGE_SCRAPER_JA4}=−1`);
      t.h.unmount();
    });

    // Lifting a promotion must put the challenge back, or the operator ends up with LESS
    // protection than before they pressed b.
    test('lifting the promotion restores the challenge and clears its marker', async () => {
      const t = await mount(withChallenge());
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      t.get().unstageDeny(t.get().entries[0]);
      await t.h.settle();
      expect(t.ja4Of(JA4_RULE)).toEqual([]);
      expect(t.ja4Of(CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST]);
      expect(t.h.frame()).not.toContain(`${CHALLENGE_SCRAPER_JA4}=`);
      t.h.unmount();
    });
  });

  describe('lifting a live deny', () => {
    test('is shown as removed and marks the rule', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST])]);
      t.get().unstageDeny(t.get().entries[0]);
      await t.h.settle();
      expect(t.h.frame()).toContain(`${DIGEST}:r`);
      expect(t.h.frame()).toContain(`${JA4_RULE}=−1`);
      t.h.unmount();
    });
  });

  describe('what the advisory asks it', () => {
    test('a live deny is enforced; a staged one is not yet', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST])]);
      expect(t.get().enforcedJa4(DIGEST)).toBe(true);

      const fresh = await mount([item(JA4_RULE, [])]);
      fresh.get().stageDeny('ja4', OTHER);
      await fresh.h.settle();
      // Staged, so it is in the local rule but has NOT reached the WAF.
      expect(fresh.get().enforcedJa4(OTHER)).toBe(false);
      expect(fresh.get().stagedJa4(OTHER)).toBe(true);
      t.h.unmount();
      fresh.h.unmount();
    });

    test('the staged lookup normalizes, so an upper-case digest is found', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST.toUpperCase());
      await t.h.settle();
      expect(t.get().stagedJa4(DIGEST)).toBe(true);
      t.h.unmount();
    });

    test('a live challenge is reported as challenged', async () => {
      const t = await mount([item(CHALLENGE_SCRAPER_JA4, [DIGEST])]);
      expect(t.get().challengedJa4(DIGEST)).toBe(true);
      expect(t.get().challengedJa4(OTHER)).toBe(false);
      t.h.unmount();
    });
  });

  describe('cursor', () => {
    test('moves within the entries and never leaves them', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST, OTHER])]);
      t.get().moveCursor(1);
      await t.h.settle();
      expect(t.h.frame()).toContain('cursor=1');
      t.get().moveCursor(1); // already at the end
      await t.h.settle();
      expect(t.h.frame()).toContain('cursor=1');
      t.get().moveCursor(-1);
      t.get().moveCursor(-1);
      await t.h.settle();
      expect(t.h.frame()).toContain('cursor=0');
      t.h.unmount();
    });

    test('an empty list parks it at 0 rather than -1', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().moveCursor(1);
      await t.h.settle();
      expect(t.h.frame()).toContain('cursor=0');
      t.h.unmount();
    });
  });

  // The `c` key's whole path: the advisory recommends CHALLENGE when a deny would hit real
  // browsers, and acting on that used to mean hand-editing .env.local.
  describe('staging a challenge', () => {
    test('it reaches the challenge rule and marks it pending', async () => {
      const t = await mount([
        item(JA4_RULE, []),
        item(CHALLENGE_SCRAPER_JA4, []),
      ]);
      expect(t.get().stageChallenge(DIGEST)).toBeUndefined();
      await t.h.settle();
      expect(t.ja4Of(CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST]);
      expect(t.ja4Of(JA4_RULE)).toEqual([]);
      expect(t.h.frame()).toContain(`${CHALLENGE_SCRAPER_JA4}=+1`);
      t.h.unmount();
    });

    test('it is listed as staged, so the pane shows it before the apply', async () => {
      const t = await mount([
        item(JA4_RULE, []),
        item(CHALLENGE_SCRAPER_JA4, []),
      ]);
      t.get().stageChallenge(DIGEST);
      await t.h.settle();
      expect(t.h.frame()).toContain(`${DIGEST}:s`);
      t.h.unmount();
    });

    test('a digest already denied is refused, and nothing is staged', async () => {
      const t = await mount([
        item(JA4_RULE, [DIGEST]),
        item(CHALLENGE_SCRAPER_JA4, []),
      ]);
      expect(t.get().stageChallenge(DIGEST)).toContain(
        'already on the deny list',
      );
      await t.h.settle();
      expect(t.ja4Of(CHALLENGE_SCRAPER_JA4)).toEqual([]);
      expect(t.edits()).toBe(0);
      t.h.unmount();
    });

    // The challenge path came from a branch cut before the batching fix, so it carried the same
    // assign-from-rendered-state defect. Pinned here, or a later merge quietly reintroduces it.
    test('a challenge and a deny staged in one tick both survive', async () => {
      const t = await mount([
        item(JA4_RULE, []),
        item(CHALLENGE_SCRAPER_JA4, []),
      ]);
      // Deny FIRST, challenge second. The other order passes either way: a fixed stageDeny
      // updater receives the challenge's result as `prev` and carries it, so the challenge's own
      // defect never shows. Whichever call is SECOND is the one under test.
      t.get().stageDeny('ja4', OTHER);
      t.get().stageChallenge(DIGEST);
      await t.h.settle();
      expect(t.ja4Of(CHALLENGE_SCRAPER_JA4)).toEqual([DIGEST]);
      expect(t.ja4Of(JA4_RULE)).toEqual([OTHER]);
      t.h.unmount();
    });

    test('an applied challenge is written to FW_CHALLENGE_JA4', async () => {
      const t = await mount([
        item(JA4_RULE, []),
        item(CHALLENGE_SCRAPER_JA4, []),
      ]);
      t.get().stageChallenge(DIGEST);
      await t.h.settle();
      const applied = new Map<string, ApplyStatus>(
        t.items().map((i) => [i.rule.name, 'overwrote' as ApplyStatus]),
      );
      const out = t.get().persist(t.items(), applied, false);
      await t.h.settle();
      expect(out.ok).toBe(true);
      expect(new Map(t.writes).get('FW_CHALLENGE_JA4')).toBe(DIGEST);
      // And NOT onto the deny list, which is the whole point of the separate key.
      expect(new Map(t.writes).get('FW_BLOCKED_JA4')).not.toBe(DIGEST);
      t.h.unmount();
    });
  });

  describe('persist', () => {
    const applied = (items: Item[]) =>
      new Map<string, ApplyStatus>(
        items.map((i) => [i.rule.name, 'overwrote' as ApplyStatus]),
      );

    test('a dry run writes nothing and keeps the staging', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      const out = t.get().persist(t.items(), applied(t.items()), true);
      await t.h.settle();
      expect(t.writes).toEqual([]);
      expect(out.ok).toBe(true);
      expect(t.h.frame()).toContain(`${DIGEST}:s`); // still pending
      t.h.unmount();
    });

    test('a real apply writes the list and clears the staging', async () => {
      const t = await mount([item(JA4_RULE, []), item(ASN_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      const out = t.get().persist(t.items(), applied(t.items()), false);
      await t.h.settle();
      expect(new Map(t.writes).get('FW_BLOCKED_JA4')).toBe(DIGEST);
      expect(out.ok).toBe(true);
      // Cleared: the edit is on disk now, so it is no longer pending.
      expect(t.h.frame()).not.toContain(`${JA4_RULE}=`);
      t.h.unmount();
    });

    test('nothing staged writes nothing at all', async () => {
      const t = await mount([item(JA4_RULE, [DIGEST])]);
      const out = t.get().persist(t.items(), applied(t.items()), false);
      expect(t.writes).toEqual([]);
      expect(out.ok).toBe(true);
      t.h.unmount();
    });

    test('a rule that failed to apply fails the run and keeps the staging', async () => {
      const t = await mount([item(JA4_RULE, [])]);
      t.get().stageDeny('ja4', DIGEST);
      await t.h.settle();
      const outcome = new Map<string, ApplyStatus>([[JA4_RULE, 'error']]);
      const out = t.get().persist(t.items(), outcome, false);
      await t.h.settle();
      expect(out.ok).toBe(false);
      expect(t.writes).toEqual([]);
      expect(t.h.frame()).toContain(`${DIGEST}:s`);
      t.h.unmount();
    });

    test('an ASN stage is written to its own var', async () => {
      const t = await mount([item(JA4_RULE, []), item(ASN_RULE, [])]);
      t.get().stageDeny('asn', AS_NUM);
      await t.h.settle();
      t.get().persist(t.items(), applied(t.items()), false);
      await t.h.settle();
      expect(new Map(t.writes).get('FW_BLOCKED_ASN')).toBe(AS_NUM);
      t.h.unmount();
    });
  });
});
