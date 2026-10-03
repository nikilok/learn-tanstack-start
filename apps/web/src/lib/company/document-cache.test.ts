import { describe, expect, test } from 'bun:test';

import { companyDocumentDegraded } from './document-cache';

describe('companyDocumentDegraded', () => {
  test('a complete document is long-cacheable', () => {
    expect(
      companyDocumentDegraded({
        profileUnavailable: false,
        hasCompanyNumber: true,
        timelineLoaded: true,
      }),
    ).toBe(false);
  });

  test('a missing timeline is degraded', () => {
    expect(
      companyDocumentDegraded({
        profileUnavailable: false,
        hasCompanyNumber: true,
        timelineLoaded: false,
      }),
    ).toBe(true);
  });

  test('no Companies House link means nothing was expected', () => {
    // A verified no-match, a public body or a CH 404: the timeline load never
    // runs, and the page is as complete as it will ever be.
    expect(
      companyDocumentDegraded({
        profileUnavailable: false,
        hasCompanyNumber: false,
        timelineLoaded: false,
      }),
    ).toBe(false);
  });

  test('a new sponsor rendered while Companies House answers 429 is degraded', () => {
    // It has no Companies House link either, so before this flag the page
    // went out without its Companies House section under the 30-day TTL.
    expect(
      companyDocumentDegraded({
        profileUnavailable: true,
        hasCompanyNumber: false,
        timelineLoaded: false,
      }),
    ).toBe(true);
  });
});
