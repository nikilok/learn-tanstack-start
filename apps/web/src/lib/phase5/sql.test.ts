import { describe, expect, test } from 'bun:test';

import type { CommitPromotionInput } from './apply-promotion.ts';
import type { ExistingMapping } from './decide.ts';
import {
  makeBumpVerifiedAt,
  makeCommitPromotion,
  makeSelectRows,
} from './sql.ts';

/**
 * Regression pins for the optimistic lock (2026-05-28 → 2026-07-07 freeze).
 *
 * `drizzle({client})` globally flips the shared neon client's timestamp
 * parsing, so `verified_at` reaches these factories as a raw microsecond
 * STRING (e.g. '2026-05-24 03:31:00.602823'), not a ms-precision Date. The
 * lock must `date_trunc` BOTH sides: truncating only the stored side compares
 * `.602` against `.602823` and matches zero rows — every bump and promotion
 * was silently discarded while the sweep summary reported success.
 */

const MICROSECOND_STRING = '2026-05-24 03:31:00.602823' as unknown as Date;

/** Both-sides-truncated lock, as it must appear in the emitted SQL. */
const LOCK_PATTERN =
  /date_trunc\('milliseconds', verified_at\)\s+IS NOT DISTINCT FROM date_trunc\('milliseconds', \$\d+::timestamp\)/;

type Captured = { text: string; params: unknown[] };

/** Fake tagged-template sql client: records each call's text (with $n
 *  placeholders) and params, resolves with a canned result. */
function makeFakeSql(result: unknown[] = []) {
  const calls: Captured[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings
      .map((s, i) => (i < values.length ? `${s}$${i + 1}` : s))
      .join('');
    calls.push({ text, params: values });
    return Promise.resolve(result);
  }) as unknown as Parameters<typeof makeBumpVerifiedAt>[0];
  return { sql, calls };
}

const existing: ExistingMapping = {
  organisationName: 'ACME LTD',
  companyNumber: null,
  matchMethod: 'no_match',
  matchScore: null,
  verifiedAt: MICROSECOND_STRING,
  isPublicBody: false,
};

const promotionInput: CommitPromotionInput = {
  organisationName: 'ACME LTD',
  originalVerifiedAt: MICROSECOND_STRING,
  newCompanyNumber: '12345678',
  newMatchMethod: 'exact',
  newMatchScore: 1,
  newQueryUsed: 'ACME LTD',
  newIsPublicBody: false,
  oldCompanyNumber: null,
  oldMatchMethod: 'no_match',
  changedBy: 'test',
};

describe('makeBumpVerifiedAt — optimistic lock', () => {
  test('truncates BOTH sides of the verified_at comparison', async () => {
    const { sql, calls } = makeFakeSql([{ organisation_name: 'ACME LTD' }]);

    await makeBumpVerifiedAt(sql)(existing);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(LOCK_PATTERN);
    expect(calls[0].params[1]).toBe(MICROSECOND_STRING);
  });

  test('returns ok when the UPDATE matched a row', async () => {
    const { sql } = makeFakeSql([{ organisation_name: 'ACME LTD' }]);

    const result = await makeBumpVerifiedAt(sql)(existing);

    expect(result).toEqual({ ok: true });
  });

  test('returns lock_missed when the UPDATE matched zero rows', async () => {
    const { sql } = makeFakeSql([]);

    const result = await makeBumpVerifiedAt(sql)(existing);

    expect(result).toEqual({ ok: false, reason: 'lock_missed' });
  });
});

describe('makeCommitPromotion — optimistic lock', () => {
  test('truncates BOTH sides of the verified_at comparison', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeCommitPromotion(sql)(promotionInput);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(LOCK_PATTERN);
    expect(calls[0].params).toContain(MICROSECOND_STRING);
  });

  test('returns null when the lock matched zero rows', async () => {
    const { sql } = makeFakeSql([]);

    const result = await makeCommitPromotion(sql)(promotionInput);

    expect(result).toBeNull();
  });

  test('returns the committed row when the lock matched', async () => {
    const { sql } = makeFakeSql([
      { company_number: '12345678', match_method: 'exact' },
    ]);

    const result = await makeCommitPromotion(sql)(promotionInput);

    expect(result).toEqual({
      organisationName: 'ACME LTD',
      newCompanyNumber: '12345678',
      newMatchMethod: 'exact',
    });
  });
});

describe('makeSelectRows — tier predicates', () => {
  /** Every tier must gate on the live register so departed orgs stop
   *  consuming sweep budget. */
  const LIVE_REGISTER_PATTERN =
    /EXISTS \(SELECT 1 FROM hmrc_skilled_workers w\s+WHERE w\.organisation_name = m\.organisation_name\)/;

  test('no_match tier also selects legacy NULL-method rows', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeSelectRows(sql)('no_match', 10);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(
      /\(match_method = 'no_match' OR match_method IS NULL\)/,
    );
    expect(calls[0].text).toMatch(LIVE_REGISTER_PATTERN);
  });

  test('non_exact tier covers all three fuzzy methods, live register only', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeSelectRows(sql)('non_exact', 10);

    expect(calls[0].text).toContain(
      "match_method IN ('token_sim', 'previous_name', 'fuzzy_edit')",
    );
    expect(calls[0].text).toMatch(LIVE_REGISTER_PATTERN);
  });

  test('exact tier covers exact + exact_squash, live register only', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeSelectRows(sql)('exact', 10);

    expect(calls[0].text).toContain(
      "match_method IN ('exact', 'exact_squash')",
    );
    expect(calls[0].text).toMatch(LIVE_REGISTER_PATTERN);
  });

  test('public_body tier gates on the live register', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeSelectRows(sql)('public_body', 10);

    expect(calls[0].text).toContain("match_method = 'public_body'");
    expect(calls[0].text).toMatch(LIVE_REGISTER_PATTERN);
  });

  test('rows order oldest-first with NULLs at the front', async () => {
    const { sql, calls } = makeFakeSql([]);

    await makeSelectRows(sql)('no_match', 10);

    expect(calls[0].text).toContain('ORDER BY verified_at ASC NULLS FIRST');
  });
});
