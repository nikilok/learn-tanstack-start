import { describe, expect, test } from 'bun:test';

import type { RevalidateInput } from './revalidate.ts';
import { DEAD_AFTER_FAILURES, revalidate } from './revalidate.ts';

const input = (over: Partial<RevalidateInput> = {}): RevalidateInput => ({
  storedUrl: 'https://www.example.co.uk',
  evidence: 'registry',
  status: 'verified',
  failureCount: 0,
  attemptedUrl: 'https://www.example.co.uk',
  outcome: { ok: true },
  ...over,
});

describe('revalidate — live pages', () => {
  test('stamps checked_at, which is what makes a row renderable at all', () => {
    const r = revalidate(input());
    expect(r.checkedAt).toBe(true);
    expect(r.status).toBe('verified');
    expect(r.failureCount).toBe(0);
  });

  test('promotes to crn_on_page when the number is on the site', () => {
    const r = revalidate(
      input({ crnFoundAt: 'https://www.example.co.uk/terms' }),
    );
    expect(r.evidence).toBe('crn_on_page');
    expect(r.evidenceUrl).toBe('https://www.example.co.uk/terms');
    expect(r.confidence).toBe('0.990');
  });

  test('does not demote a registry row to the weaker postcode tier', () => {
    // postcode_on_page (3) is below registry (4); finding it is corroboration,
    // not a downgrade.
    const r = revalidate(
      input({ postcodeFoundAt: 'https://www.example.co.uk/contact' }),
    );
    expect(r.evidence).toBe('registry');
  });

  test('promotes a candidate row when the postcode is found', () => {
    const r = revalidate(
      input({
        evidence: 'domain_similarity',
        status: 'candidate',
        postcodeFoundAt: 'https://www.example.co.uk',
      }),
    );
    expect(r.evidence).toBe('postcode_on_page');
    expect(r.status).toBe('verified');
  });

  test('prefers the number over the postcode when both are present', () => {
    const r = revalidate(
      input({
        crnFoundAt: 'https://www.example.co.uk',
        postcodeFoundAt: 'https://www.example.co.uk',
      }),
    );
    expect(r.evidence).toBe('crn_on_page');
  });

  test('adopts the variant that answered when the stored url did not', () => {
    // ~8% of rows are live only on a host or scheme variant; leaving the stored
    // url in place would keep a link that does not work.
    const r = revalidate(input({ attemptedUrl: 'https://example.co.uk' }));
    expect(r.url).toBe('https://example.co.uk');
    expect(r.note).toContain('adopted');
  });

  test('leaves a working url alone rather than churning it', () => {
    const r = revalidate(input());
    expect(r.url).toBe('https://www.example.co.uk');
    expect(r.note).not.toContain('adopted');
  });

  test('revives a row that was dead and now answers', () => {
    const r = revalidate(input({ status: 'dead', failureCount: 3 }));
    expect(r.status).toBe('verified');
    expect(r.failureCount).toBe(0);
  });

  test('never promotes above a manual owner decision', () => {
    const r = revalidate(
      input({ evidence: 'manual', crnFoundAt: 'https://www.example.co.uk' }),
    );
    expect(r.evidence).toBe('manual');
  });
});

describe('revalidate — failures', () => {
  test('one failure does not kill a row, but does un-render it', () => {
    // A timeout or a certificate renewal looks identical to a dead domain at
    // the moment it happens, so the row is not written off. It must still stop
    // rendering: checked_at is stamped on every pass, so a failed row left as
    // `verified` would satisfy the render gate and publish an unreachable link.
    const r = revalidate(input({ outcome: { ok: false, reason: 'timeout' } }));
    expect(r.status).toBe('unreachable');
    expect(r.failureCount).toBe(1);
    expect(r.checkedAt).toBe(true);
  });

  test('an unreachable row returns to verified as soon as it answers', () => {
    const r = revalidate(input({ status: 'unreachable', failureCount: 1 }));
    expect(r.status).toBe('verified');
    expect(r.failureCount).toBe(0);
  });

  test('consecutive failures do', () => {
    const r = revalidate(
      input({
        failureCount: DEAD_AFTER_FAILURES - 1,
        outcome: { ok: false, reason: 'dns_or_refused' },
      }),
    );
    expect(r.status).toBe('dead');
    expect(r.failureCount).toBe(DEAD_AFTER_FAILURES);
  });

  test('a dead row keeps its identity evidence, it is not re-judged', () => {
    const r = revalidate(
      input({
        evidence: 'crn_on_page',
        failureCount: DEAD_AFTER_FAILURES - 1,
        outcome: { ok: false, reason: 'dns_or_refused' },
      }),
    );
    expect(r.status).toBe('dead');
    expect(r.evidence).toBe('crn_on_page');
  });

  test('a manual row goes dead without losing its tier', () => {
    const r = revalidate(
      input({
        evidence: 'manual',
        failureCount: DEAD_AFTER_FAILURES - 1,
        outcome: { ok: false, reason: 'dns_or_refused' },
      }),
    );
    expect(r.status).toBe('dead');
    expect(r.evidence).toBe('manual');
  });

  test('a failed pass never rewrites the url', () => {
    const r = revalidate(
      input({
        attemptedUrl: 'http://example.co.uk',
        outcome: { ok: false, reason: 'dns_or_refused' },
      }),
    );
    expect(r.url).toBe('https://www.example.co.uk');
  });
});

describe('revalidate — hosts that answered but were not read', () => {
  // These replace an earlier suite that asserted the opposite. That suite was
  // pinning a defect: it exempted robots bans, 403s and unreadable bodies from
  // the failure path entirely, which let a URL nobody had ever fetched satisfy
  // the render gate AND made a permanently-refusing host immortal. The
  // exemption was wrong on the architecture's own terms — `verified` plus a
  // stamped checked_at asserts "we fetched this and it answered", and none of
  // these did.
  const unread = [
    {
      label: 'robots ban',
      outcome: { ok: false as const, reason: 'blocked_by_robots' as const },
    },
    {
      label: '403 bot management',
      outcome: {
        ok: false as const,
        reason: 'http_error' as const,
        status: 403,
      },
    },
    {
      label: '429 rate limited',
      outcome: {
        ok: false as const,
        reason: 'http_error' as const,
        status: 429,
      },
    },
    {
      label: '503 origin down',
      outcome: {
        ok: false as const,
        reason: 'http_error' as const,
        status: 503,
      },
    },
    {
      label: 'non-HTML body',
      outcome: { ok: false as const, reason: 'not_html' as const },
    },
  ];

  test('none of them may render, because none of them read the url', () => {
    for (const u of unread) {
      const r = revalidate(input({ outcome: u.outcome }));
      expect(r.status, u.label).not.toBe('verified');
      expect(r.verified, u.label).toBe(false);
    }
  });

  test('all of them progress toward dead, so nothing is immortal', () => {
    for (const u of unread) {
      const first = revalidate(input({ outcome: u.outcome }));
      expect(first.failureCount, u.label).toBe(1);
      const second = revalidate(input({ failureCount: 1, outcome: u.outcome }));
      expect(second.status, u.label).toBe('dead');
    }
  });

  test('the note still distinguishes a refusal from a dead domain', () => {
    // The operator needs to tell bot management from a domain that has gone,
    // even though both end at the same verdict.
    const refused = revalidate(
      input({ outcome: { ok: false, reason: 'http_error', status: 403 } }),
    );
    expect(refused.note).toContain('host answered');
    const gone = revalidate(
      input({ outcome: { ok: false, reason: 'dns_or_refused' } }),
    );
    expect(gone.note).not.toContain('host answered');
  });

  test('a 404 is not dressed up as an answer', () => {
    // The page is genuinely gone, which for a stored franchise path is exactly
    // the broken link the sweep exists to find.
    const r = revalidate(
      input({ outcome: { ok: false, reason: 'http_error', status: 404 } }),
    );
    expect(r.status).toBe('unreachable');
    expect(r.failureCount).toBe(1);
  });

  test('any of them recovers the moment a real fetch succeeds', () => {
    const r = revalidate(input({ status: 'unreachable', failureCount: 1 }));
    expect(r.status).toBe('verified');
    expect(r.failureCount).toBe(0);
  });
});

describe('name corroboration — the one revocable rung', () => {
  const live = (over: Partial<Parameters<typeof revalidate>[0]> = {}) =>
    revalidate({
      storedUrl: 'https://www.brendoncare.org.uk',
      evidence: 'registry',
      status: 'verified',
      failureCount: 0,
      attemptedUrl: 'https://www.brendoncare.org.uk',
      outcome: { ok: true },
      ...over,
    });

  test('promotes a registry row whose page names the company', () => {
    const result = live({ nameCorroborated: true });
    expect(result.evidence).toBe('registry_confirmed');
    expect(result.status).toBe('verified');
    expect(Number(result.confidence)).toBeGreaterThan(0.95);
  });

  test('WITHDRAWS the confirmation when corroboration disappears', () => {
    // The decay this tier exists for: the site is rebuilt, the domain changes
    // hands, or the company is renamed, and the page stops naming it. Upgrade-
    // only applies to discovery — revalidation is allowed to move a row down,
    // and a latched rung here would keep publishing the link.
    const result = live({
      evidence: 'registry_confirmed',
      nameCorroborated: false,
    });
    expect(result.evidence).toBe('registry');
    expect(result.note).toContain('no longer corroborated');
  });

  test('re-confirms without churn when corroboration is still there', () => {
    expect(
      live({ evidence: 'registry_confirmed', nameCorroborated: true }).evidence,
    ).toBe('registry_confirmed');
  });

  test('never touches a registered number found on the page', () => {
    // crn_on_page outranks it, and a missing name match must not undo it.
    expect(
      live({ evidence: 'crn_on_page', nameCorroborated: false }).evidence,
    ).toBe('crn_on_page');
  });

  test('never overturns an owner decision', () => {
    expect(live({ evidence: 'manual', nameCorroborated: false }).evidence).toBe(
      'manual',
    );
    expect(live({ evidence: 'manual', nameCorroborated: true }).evidence).toBe(
      'manual',
    );
  });

  test('does not promote a tier the rule was never measured on', () => {
    // Measured only against registry rows, where the name confirms a claim an
    // exact company-number join already made. Standing alone it is far weaker.
    expect(
      live({ evidence: 'registry_unconfirmed', nameCorroborated: true })
        .evidence,
    ).toBe('registry_unconfirmed');
  });
});

describe('parked and directory pages', () => {
  const live = (over: Partial<Parameters<typeof revalidate>[0]> = {}) =>
    revalidate({
      storedUrl: 'https://www.pinnaclecarehome.com',
      evidence: 'registry',
      status: 'verified',
      failureCount: 0,
      attemptedUrl: 'https://www.pinnaclecarehome.com',
      outcome: { ok: true },
      ...over,
    });

  test('holds a row back from rendering without calling it dead', () => {
    // A holding page answers 200, so liveness cannot see it. It is an identity
    // failure, not a liveness one — the row keeps its evidence and its failure
    // count, and simply stops rendering.
    const result = live({ noSiteThere: true });
    expect(result.status).toBe('candidate');
    expect(result.evidence).toBe('registry');
    expect(result.live).toBe(true);
    expect(result.failureCount).toBe(0);
  });

  test('restores the row on its own once a real site appears', () => {
    expect(live({ noSiteThere: false }).status).toBe('verified');
  });

  test('holds back even a corroborated row', () => {
    // Pinnacle Care Homes Limited -> pinnaclecarehome.com, a "Coming Soon"
    // page on the company's own domain: the name matches, and there is still
    // nothing worth linking to.
    expect(live({ nameCorroborated: true, noSiteThere: true }).status).toBe(
      'candidate',
    );
  });
});
