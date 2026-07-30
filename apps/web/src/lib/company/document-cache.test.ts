import { describe, expect, test } from 'bun:test';

import { companyDocumentDegraded } from './document-cache';

const ok = {
  hasCompanyNumber: true,
  timelineLoaded: true,
  websiteLookupFailed: false,
};

describe('companyDocumentDegraded', () => {
  test('a complete document is long-cacheable', () => {
    expect(companyDocumentDegraded(ok)).toBe(false);
  });

  test('a successful "no website" is NOT degraded', () => {
    // The load succeeded and the honest answer was null, which is the case for
    // roughly 99.9% of companies today. Calling that degraded would drop the
    // entire site onto the short TTL.
    expect(companyDocumentDegraded({ ...ok, websiteLookupFailed: false })).toBe(
      false,
    );
  });

  test('a FAILED website lookup is degraded', () => {
    // The defect this exists for: the catch collapses an RPC failure to null,
    // so the document renders with no website link and, unguarded, that
    // rendering is what gets edge-cached for 30 days — for a company we have
    // confirmed a website for.
    expect(companyDocumentDegraded({ ...ok, websiteLookupFailed: true })).toBe(
      true,
    );
  });

  test('a missing timeline is degraded, as it was before', () => {
    expect(companyDocumentDegraded({ ...ok, timelineLoaded: false })).toBe(
      true,
    );
  });

  test('no Companies House link means nothing was expected', () => {
    // Neither load runs without a company number, so their absence says
    // nothing about the document being incomplete.
    expect(
      companyDocumentDegraded({
        hasCompanyNumber: false,
        timelineLoaded: false,
        websiteLookupFailed: false,
      }),
    ).toBe(false);
  });
});
