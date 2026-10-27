import { describe, expect, test } from 'bun:test';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  ANSWER_RETENTION_STATUSES,
  ASSESSED_PUBLISHES,
  answersRetentionGate,
  NAMED_HOST_LIVE_DAYS,
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
    // whose company has no postcode, cannot publish through this arm. The
    // arm-off shape: the assessed arm's own tests pin what switching it on adds.
    expect(render(publishableWebsiteGate({ assessed: false }))).toEqual({
      text: '("company_websites"."status" = $1 and "company_websites"."checked_at" is not null and ("company_websites"."evidence" in ($2, $3, $4) or ("company_websites"."source" = $5 and "company_websites"."evidence" = $6 and "company_websites"."postcode_share" <= $7) or ("company_websites"."source" = $8 and "company_websites"."evidence" = $9) or (("company_websites"."source" = $10 and "company_websites"."evidence" = $11 and "company_websites"."postcode_share" is not null and "company_websites"."named_url" = "company_websites"."url") and "company_websites"."checked_at" >= now() - make_interval(days => $12))) and "company_websites"."url" is not null)',
      params: [
        'verified',
        'manual',
        'crn_on_page',
        'registry_confirmed',
        'search',
        'postcode_on_page',
        10,
        'search',
        'name_and_place',
        'search',
        'postcode_on_page',
        45,
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

  test('retention carries the same arms, wider only on status and the sweep check', () => {
    // A company whose share rises past the limit on a host that does not name
    // it loses its answers as it loses its link. Retention may only be wider
    // on the transient status, and on a sweep that has not come round lately.
    const publish = render(publishableWebsiteGate({ assessed: false }));
    const retain = render(answersRetentionGate({ assessed: false }));
    const shape = (text: string) => text.replace(/\$\d+/g, '?');
    expect(shape(retain.text)).toBe(
      shape(publish.text)
        .replace(
          '"company_websites"."status" = ?',
          '"company_websites"."status" in (?, ?)',
        )
        .replace(
          /\((\("company_websites"\."source" = \? and [^)]*"company_websites"\."named_url" = "company_websites"\."url"\)) and "company_websites"\."checked_at" >= now\(\) - make_interval\(days => \?\)\)/,
          '$1',
        ),
    );
    expect(retain.params).toEqual([
      'verified',
      'unreachable',
      ...publish.params.slice(1, -1),
    ]);
  });
});

describe('the named-host arm', () => {
  test('admits a postcode row at any share only while its named url is still its url', () => {
    // The 2026-10-24 sample of rows the share limit held: where the host names
    // the company, 77/77 that loaded were right at every share band drawn. A
    // url changed since the sweep last checked its host fails the equality, so
    // no writer has to clear named_url for the gate to close.
    const { text, params } = render(publishableWebsiteGate());
    expect(text).toContain(
      '("company_websites"."source" = $10 and "company_websites"."evidence" = $11 and "company_websites"."postcode_share" is not null and "company_websites"."named_url" = "company_websites"."url")',
    );
    expect(params.slice(9, 11)).toEqual(['search', 'postcode_on_page']);
  });

  test('publishes only a row a sweep confirmed live within NAMED_HOST_LIVE_DAYS', () => {
    // Every row the arm admitted at release had been checked within 30 days,
    // and the sweep comes round monthly: 45 days closes the arm on a stalled
    // sweep without flickering rows at the edge of a cycle.
    expect(NAMED_HOST_LIVE_DAYS).toBe(45);
    const { text, params } = render(publishableWebsiteGate());
    expect(text).toContain(
      'and "company_websites"."checked_at" >= now() - make_interval(days => $12))',
    );
    expect(params.at(-1)).toBe(NAMED_HOST_LIVE_DAYS);
    // Retention keeps the arm with no bound: a stalled sweep is no loss.
    expect(render(answersRetentionGate()).text).not.toContain('make_interval');
  });
});

describe('the name-and-place arm', () => {
  test('admits a search row the two-signal rule proved, on both gates', () => {
    // Sealed before a fresh draw and scored 65/65 on it (lower bound 96.0%);
    // only search rows were measured, as with the postcode arms.
    const arm =
      '("company_websites"."source" = $8 and "company_websites"."evidence" = $9)';
    const { text, params } = render(publishableWebsiteGate());
    expect(text).toContain(arm);
    expect(params.slice(7, 9)).toEqual(['search', 'name_and_place']);
    const retain = render(answersRetentionGate());
    expect(retain.text).toContain(
      '("company_websites"."source" = $9 and "company_websites"."evidence" = $10)',
    );
    expect(retain.params.slice(8, 10)).toEqual(['search', 'name_and_place']);
  });
});

describe('the assessed arm', () => {
  const arm =
    '"company_websites"."source" = $13 and "company_websites"."evidence" = $14 and "company_websites"."named_url" = "company_websites"."url" and exists (select 1 from "companies_house_profiles" where ("companies_house_profiles"."company_number" = "company_websites"."company_number" and "companies_house_profiles"."company_status" = $15))';

  test('ships switched on, so both gates carry the arm by default', () => {
    // On since the first pass's audit cleared the tier.
    expect(ASSESSED_PUBLISHES).toBe(true);
    const shape = (gate: SQL) => render(gate).text;
    expect(shape(publishableWebsiteGate())).toBe(
      shape(publishableWebsiteGate({ assessed: true })),
    );
    expect(shape(answersRetentionGate())).toBe(
      shape(answersRetentionGate({ assessed: true })),
    );
  });

  test('switching it on only adds the arm to each gate', () => {
    const END = ') and "company_websites"."url" is not null)';
    for (const [on, off] of [
      [publishableWebsiteGate(), publishableWebsiteGate({ assessed: false })],
      [answersRetentionGate(), answersRetentionGate({ assessed: false })],
    ]) {
      const a = render(on),
        b = render(off);
      expect(a.text.startsWith(b.text.slice(0, b.text.lastIndexOf(END)))).toBe(
        true,
      );
      expect(a.text.endsWith(END)).toBe(true);
      expect(a.params.slice(0, b.params.length)).toEqual(b.params);
    }
  });

  test('switched off, both gates are exactly what they were without it', () => {
    // The rollback: every assessed row leaves both gates at once.
    for (const gate of [
      publishableWebsiteGate({ assessed: false }),
      answersRetentionGate({ assessed: false }),
    ]) {
      const { text, params } = render(gate);
      expect(text).not.toContain(arm);
      expect(params).not.toContain('assessed');
      expect(params).toHaveLength(12);
    }
  });

  test('switched on, admits a search row whose url host names an active company, swept recently', () => {
    // The host check is named_url, refreshed every sweep run, so a rename that
    // stops naming the company closes the arm at the next run; a company that
    // stops being active closes it at once.
    const { text, params } = render(publishableWebsiteGate({ assessed: true }));
    expect(text).toContain(
      `((${arm}) and "company_websites"."checked_at" >= now() - make_interval(days => $16))`,
    );
    expect(params.slice(12)).toEqual([
      'search',
      'assessed',
      'active',
      NAMED_HOST_LIVE_DAYS,
    ]);
  });

  test('retention keeps the arm without the sweep bound', () => {
    const { text, params } = render(answersRetentionGate({ assessed: true }));
    expect(text).toContain(`(${arm})`);
    expect(text.match(/make_interval/g)).toBeNull();
    expect(params.slice(12)).toEqual(['search', 'assessed', 'active']);
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
