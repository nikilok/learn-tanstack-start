import { describe, expect, test } from 'bun:test';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  ANSWER_RETENTION_STATUSES,
  answersRetentionGate,
  POSTCODE_SHARE_LIMIT,
  PUBLISHABLE_EVIDENCE,
  publishableWebsiteGate,
} from './publishable';

const dialect = new PgDialect();

/** Render a gate to SQL text and its bound params. */
function render(gate: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(gate);
  return { text: query.sql, params: query.params };
}

describe('PUBLISHABLE_EVIDENCE', () => {
  test('publishes only tiers a measurement or an owner stands behind', () => {
    // Each entry earned its place differently and none may drift in:
    // crn_on_page is the company publishing its own registration number,
    // manual is an owner decision, and registry_confirmed is the registered
    // office postcode on the page — measured at 97.9% over 97 rows with zero
    // wrong, and shipped as a judgement call recorded in publishable.ts.
    expect([...PUBLISHABLE_EVIDENCE].sort()).toEqual([
      'crn_on_page',
      'manual',
      'registry_confirmed',
    ]);
  });

  test('bare registry is NOT publishable', () => {
    // The measurement that matters: the registry tier as a whole is 90%
    // precise, and the rows it would add beyond registry_confirmed were 14/29.
    // This is the assertion that fails if anyone widens the list to `registry`.
    expect(PUBLISHABLE_EVIDENCE).not.toContain('registry');
    expect(PUBLISHABLE_EVIDENCE).not.toContain('registry_unconfirmed');
  });

  test('postcode_on_page as a whole is NOT publishable', () => {
    // Only its measured slice is, through the gate's own arm: the full tier
    // was 214/220 with its pooled lower bound under the bar, and four of the
    // six misses sat at postcodes shared by more than ten companies.
    expect(PUBLISHABLE_EVIDENCE).not.toContain('postcode_on_page');
  });
});

describe('the shared-postcode arm', () => {
  test('admits a postcode shared by at most ten mapped companies', () => {
    // The threshold the 2026-10-19 sample cleared: share <= 10 was 148/150
    // (lower bound 96.1%) and 197/200 with the later validation sample, while
    // share <= 50 was inconclusive. Moving it needs a new measurement, not an
    // edit.
    expect(POSTCODE_SHARE_LIMIT).toBe(10);
  });

  test('the render gate keeps every arm and adds the share bound', () => {
    // `<=` on a NULL share is NULL, so a row the refresh has not reached, or
    // whose company has no postcode, cannot publish through this arm.
    expect(render(publishableWebsiteGate())).toEqual({
      text: '("company_websites"."status" = $1 and "company_websites"."checked_at" is not null and ("company_websites"."evidence" in ($2, $3, $4) or ("company_websites"."source" = $5 and "company_websites"."evidence" = $6 and "company_websites"."postcode_share" <= $7)) and "company_websites"."url" is not null)',
      params: [
        'verified',
        'manual',
        'crn_on_page',
        'registry_confirmed',
        'search',
        'postcode_on_page',
        10,
      ],
    });
  });

  test('only search rows qualify, because only search rows were measured', () => {
    // The sweep promotes a registry row onto postcode_on_page when its page
    // shows the postcode, and one CQC row had got there by 2026-10-20. None
    // was in the sample, so dropping the source condition publishes it blind.
    const { text, params } = render(publishableWebsiteGate());
    expect(text).toContain(
      '("company_websites"."source" = $5 and "company_websites"."evidence" = $6',
    );
    expect(params.slice(4, 6)).toEqual(['search', 'postcode_on_page']);
  });

  test('retention carries the same arm and differs only in status', () => {
    // A company whose share rises past the limit loses its answers as it
    // loses its link; retention may only be wider on the transient status.
    const publish = render(publishableWebsiteGate());
    const retain = render(answersRetentionGate());
    const shape = (text: string) => text.replace(/\$\d+/g, '?');
    expect(shape(retain.text)).toBe(
      shape(publish.text).replace(
        '"company_websites"."status" = ?',
        '"company_websites"."status" in (?, ?)',
      ),
    );
    expect(retain.params).toEqual([
      'verified',
      'unreachable',
      ...publish.params.slice(1),
    ]);
  });
});

describe('ANSWER_RETENTION_STATUSES', () => {
  test('tolerates the transient state, never the terminal ones', () => {
    // The revalidation sweep flips verified → unreachable after ONE failed
    // fetch and the state self-heals on the next pass that answers. Retention
    // must ride through that blip; everything terminal must fire it.
    expect([...ANSWER_RETENTION_STATUSES].sort()).toEqual([
      'unreachable',
      'verified',
    ]);
  });

  test('genuine loss states are NOT retained', () => {
    expect(ANSWER_RETENTION_STATUSES).not.toContain('dead');
    expect(ANSWER_RETENTION_STATUSES).not.toContain('none');
    expect(ANSWER_RETENTION_STATUSES).not.toContain('candidate');
  });
});
