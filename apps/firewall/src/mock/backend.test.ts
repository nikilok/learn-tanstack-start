import { describe, expect, test } from 'bun:test';

import type { Ctx } from '../observability';
import type { Rule } from '../rules';
import type { Item, LiveConfig } from '../seed-items';
import { type Miss, mockObservability, mockWaf } from './backend';
import { type LoadedCassette, RULE_NAMES_KEY, metricsKeys } from './cassette';

const CTX: Ctx = {
  projectId: 'prj',
  teamId: 'team',
  headers: {},
  qs: '',
  startTime: '2026-08-15T04:00:00.000Z',
  endTime: '2026-08-15T10:00:00.000Z',
  granularity: { hours: 1 },
};

const RECORDED = { summary: [{ clientIp: '1.2.3.4', count_sum: 91 }] };

function cassetteWith(
  entries: [string, unknown][],
  loose: [string, unknown][] = [],
): LoadedCassette {
  return { entries: new Map(entries), loose: new Map(loose), skipped: 0 };
}

function collecting(): { misses: Miss[]; onMiss: (m: Miss) => void } {
  const misses: Miss[] = [];
  return { misses, onMiss: (m) => misses.push(m) };
}

describe('replayed observability', () => {
  test('answers a recorded query with what was recorded', async () => {
    const { exact } = metricsKeys(CTX, ['clientIp'], {});
    const { misses, onMiss } = collecting();
    const backend = mockObservability(
      cassetteWith([[exact, RECORDED]]),
      onMiss,
    );
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RECORDED);
    expect(misses).toEqual([]);
  });

  // The operator moves the window constantly. A corpus that only answers the range it was recorded
  // at would be unusable within one keypress.
  test('falls back to another window for the same query, and says so', async () => {
    const { loose } = metricsKeys(CTX, ['clientIp'], {});
    const { misses, onMiss } = collecting();
    const backend = mockObservability(
      cassetteWith([], [[loose, RECORDED]]),
      onMiss,
    );
    const wider: Ctx = { ...CTX, startTime: '2026-08-01T10:00:00.000Z' };
    expect(await backend.metrics(wider, ['clientIp'], {})).toEqual(RECORDED);
    expect(misses.map((m) => m.reason)).toEqual(['window-substituted']);
  });

  test('prefers the exact recording over the fallback', async () => {
    const { exact, loose } = metricsKeys(CTX, ['clientIp'], {});
    const other = { summary: [{ clientIp: '9.9.9.9', count_sum: 1 }] };
    const { misses, onMiss } = collecting();
    const backend = mockObservability(
      cassetteWith([[exact, RECORDED]], [[loose, other]]),
      onMiss,
    );
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RECORDED);
    expect(misses).toEqual([]);
  });

  // An empty response is what a genuinely quiet window returns, so every reader already handles it.
  // Throwing instead would take out the pane over a gap in the corpus.
  test('an unrecorded query is a well-formed empty response, and is reported', async () => {
    const { misses, onMiss } = collecting();
    const backend = mockObservability(cassetteWith([]), onMiss);
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual({
      data: [],
      summary: [],
    });
    expect(misses.map((m) => m.reason)).toEqual(['unrecorded']);
    expect(misses[0].key).toBe(metricsKeys(CTX, ['clientIp'], {}).exact);
  });

  test('replays the rule-name lookup', async () => {
    const { onMiss } = collecting();
    const backend = mockObservability(
      cassetteWith([[RULE_NAMES_KEY, [['rule_1', 'ja4-denylist']]]]),
      onMiss,
    );
    expect(await backend.ruleNames(CTX)).toEqual(
      new Map([['rule_1', 'ja4-denylist']]),
    );
  });

  test('an unrecorded rule-name lookup is the empty map the live one degrades to', async () => {
    const { misses, onMiss } = collecting();
    const backend = mockObservability(cassetteWith([]), onMiss);
    expect((await backend.ruleNames(CTX)).size).toBe(0);
    expect(misses.map((m) => m.reason)).toEqual(['unrecorded']);
  });
});

function ruleNamed(name: string): Rule {
  return {
    name,
    description: 'mock',
    active: true,
    // `ex`, not `eq`: an existence check is the only condition headerKeysByGroup counts as a
    // header requirement, and it is what the real allow rules are built with.
    conditionGroup: [
      { conditions: [{ type: 'header', op: 'ex', key: 'x-mock-token' }] },
    ],
    action: { mitigate: { action: 'log' } },
  } as Rule;
}

function itemFor(name: string, action: Item['action'] = 'log'): Item {
  return { rule: ruleNamed(name), active: true, action, status: 'idle' };
}

const EMPTY_LIVE: LiveConfig = {
  idByName: new Map(),
  activeByName: new Map(),
  actionByName: new Map(),
  headerKeysByName: new Map(),
};

describe('the in-memory WAF', () => {
  test('starts from what was recorded', async () => {
    const waf = mockWaf(
      {
        ...EMPTY_LIVE,
        idByName: new Map([['ja4-denylist', 'rule_1']]),
        actionByName: new Map([['ja4-denylist', 'deny']]),
      },
      { dryRun: false },
    );
    const live = await waf.fetchLive();
    expect(live.idByName.get('ja4-denylist')).toBe('rule_1');
    expect(live.actionByName.get('ja4-denylist')).toBe('deny');
  });

  // The flow this mode exists for — stage a challenge, promote it to a deny, lift it — reads as a
  // no-op at every step if an apply does not change what the next fetch returns.
  test('an apply changes what the next fetch returns', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    expect(
      await waf.applyItem(itemFor('ja4-denylist', 'deny'), new Map()),
    ).toEqual({ status: 'inserted' });
    const live = await waf.fetchLive();
    expect(live.actionByName.get('ja4-denylist')).toBe('deny');
    expect(live.activeByName.get('ja4-denylist')).toBe(true);
    expect(live.idByName.has('ja4-denylist')).toBe(true);
  });

  test('applying a rule it already knows overwrites rather than inserts', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    await waf.applyItem(itemFor('ja4-denylist', 'log'), new Map());
    expect(
      await waf.applyItem(itemFor('ja4-denylist', 'deny'), new Map()),
    ).toEqual({ status: 'overwrote' });
    expect((await waf.fetchLive()).actionByName.get('ja4-denylist')).toBe(
      'deny',
    );
  });

  test('keeps the id it first assigned, since the report labels rows by it', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    await waf.applyItem(itemFor('ja4-denylist'), new Map());
    const first = (await waf.fetchLive()).idByName.get('ja4-denylist');
    await waf.applyItem(itemFor('ja4-denylist', 'deny'), new Map());
    expect((await waf.fetchLive()).idByName.get('ja4-denylist')).toBe(first);
  });

  test('records the header keys the applied rule requires, which is what trusts an allow rule', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    await waf.applyItem(
      itemFor('allow-ch-stream-revalidate', 'bypass'),
      new Map(),
    );
    expect(
      (await waf.fetchLive()).headerKeysByName.get(
        'allow-ch-stream-revalidate',
      ),
    ).toEqual([new Set(['x-mock-token'])]);
  });

  test('a caller that mutates what it read cannot rewrite the session behind its back', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    await waf.applyItem(itemFor('ja4-denylist', 'deny'), new Map());
    const live = await waf.fetchLive();
    live.actionByName.set('ja4-denylist', 'log');
    live.idByName.delete('ja4-denylist');
    const again = await waf.fetchLive();
    expect(again.actionByName.get('ja4-denylist')).toBe('deny');
    expect(again.idByName.has('ja4-denylist')).toBe(true);
  });

  // A dry run that still mutated would leave the WAF changed and the persisted lists not — the
  // two halves of an apply disagreeing, inside the mode built to rehearse them together.
  test('a dry run reports what would happen and changes nothing', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: true });
    expect(
      await waf.applyItem(itemFor('ja4-denylist', 'deny'), new Map()),
    ).toEqual({ status: 'inserted', detail: 'dry-run' });
    expect((await waf.fetchLive()).idByName.size).toBe(0);
  });

  // The one case where the chosen action and the applied action differ. `withAction` refuses to
  // turn the recoverable challenge rule into a deny, so a mock that recorded item.action showed
  // the tier as denying while the real WAF would still be challenging — the exact rule this mode
  // exists to exercise. Probed across all 18 rules x 4 actions: this is the only divergence.
  test('records the action the RULE ended up with, not the one that was asked for', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    const recoverable = ruleNamed('challenge-scraper-ja4');
    recoverable.action = { mitigate: { action: 'challenge' } };
    await waf.applyItem(
      { rule: recoverable, active: true, action: 'deny', status: 'idle' },
      new Map(),
    );
    expect(
      (await waf.fetchLive()).actionByName.get('challenge-scraper-ja4'),
    ).toBe('challenge');
  });

  test('an inactive item applies as inactive, so the pane shows what the WAF would evaluate', async () => {
    const waf = mockWaf(EMPTY_LIVE, { dryRun: false });
    await waf.applyItem(
      { ...itemFor('ja4-denylist', 'deny'), active: false },
      new Map(),
    );
    expect((await waf.fetchLive()).activeByName.get('ja4-denylist')).toBe(
      false,
    );
  });
});
