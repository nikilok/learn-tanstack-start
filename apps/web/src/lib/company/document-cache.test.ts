import { describe, expect, test } from 'bun:test';

import { companyDocumentDegraded } from './document-cache';

describe('companyDocumentDegraded', () => {
  test('a complete document is long-cacheable', () => {
    expect(
      companyDocumentDegraded({ hasCompanyNumber: true, timelineLoaded: true }),
    ).toBe(false);
  });

  test('a missing timeline is degraded', () => {
    expect(
      companyDocumentDegraded({
        hasCompanyNumber: true,
        timelineLoaded: false,
      }),
    ).toBe(true);
  });

  test('no Companies House link means nothing was expected', () => {
    // The timeline load never runs without a company number, so its absence
    // says nothing about the document being incomplete.
    expect(
      companyDocumentDegraded({
        hasCompanyNumber: false,
        timelineLoaded: false,
      }),
    ).toBe(false);
  });
});
