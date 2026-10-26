import { describe, expect, test } from 'bun:test';

import type { ChResponse } from '../../src/lib/hmrc-ch/ch-lookup.ts';
import {
  makeOfficerLookup,
  OFFICER_BREAKER,
  OFFICER_CALLS_PER_SECOND,
  OFFICER_RETRIES,
} from './ch-officers.ts';

/** A lookup against canned responses on a fake clock, recording calls and pauses. */
function lookupWith(responses: ChResponse[], workers = 1) {
  let clock = 0;
  const paths: string[] = [];
  const calledAt: number[] = [];
  const pauses: number[] = [];
  const lookup = makeOfficerLookup({
    apiKey: 'unused',
    workers,
    fetchCh: async (path) => {
      paths.push(path);
      calledAt.push(clock);
      return responses[Math.min(paths.length, responses.length) - 1];
    },
    sleep: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { lookup, paths, calledAt, pauses };
}

const officers = {
  ok: true,
  data: { items: [{ name: 'TALLOWMERE, Idris', officer_role: 'director' }] },
} as const;

describe('makeOfficerLookup', () => {
  test("asks for one company's officers, people only", async () => {
    const { lookup, paths } = lookupWith([officers]);
    expect(await lookup('09990117')).toEqual([
      { forename: 'IDRIS', surname: 'TALLOWMERE', current: true },
    ]);
    expect(paths).toEqual(['/company/09990117/officers?items_per_page=100']);
  });

  test("paces every worker to its part of the job's share of the key", async () => {
    expect(OFFICER_CALLS_PER_SECOND).toBe(0.5);
    const { lookup, calledAt } = lookupWith([officers], 12);
    await lookup('09990117');
    await lookup('09990118');
    await lookup('09990119');
    expect(calledAt).toEqual([0, 24_000, 48_000]);
  });

  test('no such company, or none listed, is no officers', async () => {
    const { lookup } = lookupWith([{ ok: false, status: 404 }]);
    expect(await lookup('09990117')).toEqual([]);
  });

  test('a rate limit or a server error is retried after a pause', async () => {
    const { lookup, paths, pauses } = lookupWith([
      { ok: false, status: 429 },
      { ok: false, status: 0, cause: 'reset' },
      officers,
    ]);
    expect(await lookup('09990117')).toHaveLength(1);
    expect(paths).toHaveLength(3);
    expect(pauses.filter((ms) => ms === 30_000)).toHaveLength(2);
  });

  test('gives up as unanswered after its retries, or at once on a refused key', async () => {
    const failing = lookupWith([{ ok: false, status: 503 }]);
    expect(await failing.lookup('09990117')).toBe('failed');
    expect(failing.paths).toHaveLength(OFFICER_RETRIES + 1);
    const refused = lookupWith([{ ok: false, status: 401 }]);
    expect(await refused.lookup('09990117')).toBe('failed');
    expect(refused.paths).toHaveLength(1);
  });

  test('stops asking after OFFICER_BREAKER failing lookups in a row; an answer resets the count', async () => {
    expect(OFFICER_BREAKER).toBe(3);
    const answered = lookupWith([
      { ok: false, status: 401 },
      { ok: false, status: 401 },
      officers,
      { ok: false, status: 401 },
    ]);
    for (const cn of ['01', '02', '03', '04', '05']) await answered.lookup(cn);
    expect(answered.paths).toHaveLength(5);
    const dead = lookupWith([{ ok: false, status: 401 }]);
    const answers = [];
    for (const cn of ['01', '02', '03', '04', '05']) {
      answers.push(await dead.lookup(cn));
    }
    expect(answers).toEqual([
      'failed',
      'failed',
      'failed',
      'stopped',
      'stopped',
    ]);
    expect(dead.paths).toHaveLength(OFFICER_BREAKER);
  });
});
