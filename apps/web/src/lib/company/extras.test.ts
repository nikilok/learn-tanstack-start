import { describe, expect, test } from 'bun:test';

import {
  companyPagePayload,
  extrasWanted,
  pageCompanyNumber,
  pageExtras,
} from './extras';
import type { CompanyPageRow } from './page-rows';

const row = (over: Partial<CompanyPageRow>): CompanyPageRow => ({
  slugId: 'hash0000001',
  organisationName: 'ACME LTD',
  companyNumber: '01111111',
  typeRating: 'Worker (A rating)',
  route: 'Skilled Worker',
  sponsorLicenceNumber: null,
  websiteUrl: null,
  ...over,
});

describe('pageExtras — the rows the page rendered, for the company it shows', () => {
  test('keeps every distinct licence number, in row order', () => {
    const rows = [
      row({ slugId: 'hash0000001', sponsorLicenceNumber: 'TESTLIC01' }),
      row({ slugId: 'hash0000002', route: 'Global Business Mobility' }),
      row({
        slugId: 'hash0000003',
        route: 'Creative Worker',
        sponsorLicenceNumber: 'TESTLIC02',
      }),
      row({
        slugId: 'hash0000004',
        route: 'Scale-up',
        sponsorLicenceNumber: 'TESTLIC01',
      }),
    ];
    const page = {
      slugIds: rows.map((r) => r.slugId),
      companyNumber: '01111111',
    };
    expect(pageExtras(rows, page, null).licenceNumbers).toEqual([
      'TESTLIC01',
      'TESTLIC02',
    ]);
  });

  test('ignores rows the page did not render', () => {
    // A row that joined the slug after the page was cached is not on it.
    const rows = [
      row({ slugId: 'hash0000001', sponsorLicenceNumber: 'TESTLIC01' }),
      row({ slugId: 'hash0000009', sponsorLicenceNumber: 'TESTLIC09' }),
    ];
    const page = { slugIds: ['hash0000001'], companyNumber: '01111111' };
    expect(pageExtras(rows, page, null).licenceNumbers).toEqual(['TESTLIC01']);
  });

  test('a page showing no company keeps its rows after they gain a mapping', () => {
    // Rendered while the org was unmapped; a later sweep mapped it. The page
    // still lists these routes, so their numbers stay with them.
    const rows = [
      row({
        slugId: 'hash0000001',
        companyNumber: '05000000',
        sponsorLicenceNumber: 'TESTLIC01',
      }),
    ];
    const page = { slugIds: ['hash0000001'], companyNumber: null };
    expect(pageExtras(rows, page, null).licenceNumbers).toEqual(['TESTLIC01']);
  });

  test('a rendered row since mapped to another company is dropped', () => {
    // The page shows 05000000 and rendered an unmapped namesake's row, which a
    // later sweep mapped to 04000000.
    const rows = [
      row({
        slugId: 'hash0000001',
        companyNumber: '04000000',
        sponsorLicenceNumber: 'TESTLIC04',
      }),
      row({
        slugId: 'hash0000002',
        companyNumber: '05000000',
        sponsorLicenceNumber: 'TESTLIC05',
      }),
    ];
    const page = {
      slugIds: ['hash0000001', 'hash0000002'],
      companyNumber: '05000000',
    };
    expect(pageExtras(rows, page, null).licenceNumbers).toEqual(['TESTLIC05']);
  });

  test('the website is the page company’s own, not whatever its rows carry', () => {
    // First visit: the row still carries an unresolved mapping, so it has no
    // website, but the page already shows the company that owns one.
    const rows = [row({ companyNumber: null, websiteUrl: null })];
    const page = { slugIds: ['hash0000001'], companyNumber: '05000000' };
    expect(pageExtras(rows, page, 'https://acme.example').website).toBe(
      'https://acme.example',
    );
  });

  test('a page showing no company has no website', () => {
    const page = { slugIds: ['hash0000001'], companyNumber: null };
    expect(pageExtras([row({})], page, 'https://acme.example').website).toBe(
      null,
    );
  });
});

describe('extrasWanted', () => {
  const empty = { licenceNumberCount: 0, hasWebsite: false };

  test('wanted whenever the outline promises a number or a website', () => {
    expect(
      extrasWanted({ licenceNumberCount: 1, hasWebsite: false }, null, null),
    ).toBe(true);
    expect(
      extrasWanted({ licenceNumberCount: 0, hasWebsite: true }, null, null),
    ).toBe(true);
  });

  test('an empty outline is trusted when it saw the page’s own company', () => {
    expect(extrasWanted(empty, '05000000', '05000000')).toBe(false);
    expect(extrasWanted(empty, null, null)).toBe(false);
  });

  test('an empty outline built before the page’s company was known is not', () => {
    // First visit: the primary row's mapping was still unresolved.
    expect(extrasWanted(empty, '05000000', null)).toBe(true);
  });
});

describe('pageCompanyNumber', () => {
  test('the profile the page shows leads, then the primary row, then none', () => {
    expect(pageCompanyNumber('05000000', '05000000')).toBe('05000000');
    // A first visit resolves the profile before the mapping row records it.
    expect(pageCompanyNumber('05000000', null)).toBe('05000000');
    expect(pageCompanyNumber(undefined, '05000000')).toBe('05000000');
    expect(pageCompanyNumber(undefined, null)).toBeNull();
    expect(pageCompanyNumber('', undefined)).toBeNull();
  });
});

// companyPagePayload is what getHmrcCompanyBySlug returns for a found page, and
// that payload is edge-cached and dehydrated into the HTML.
describe('companyPagePayload — the outline, never the values', () => {
  const pool = [
    row({
      sponsorLicenceNumber: 'TESTLIC01',
      websiteUrl: 'https://acme.example',
    }),
    row({ route: 'Creative Worker', sponsorLicenceNumber: 'TESTLIC02' }),
  ];

  test('neither value appears anywhere in the serialised payload', () => {
    const payload = JSON.stringify(companyPagePayload(pool));
    expect(payload).not.toContain('TESTLIC01');
    expect(payload).not.toContain('TESTLIC02');
    expect(payload).not.toContain('acme.example');
  });

  test('licence rows keep exactly the payload fields', () => {
    for (const licence of companyPagePayload(pool).licences) {
      expect(Object.keys(licence).sort()).toEqual([
        'companyNumber',
        'organisationName',
        'route',
        'slugId',
        'typeRating',
      ]);
    }
  });

  test('the outline counts the numbers and flags the website', () => {
    expect(companyPagePayload(pool).extras).toEqual({
      licenceNumberCount: 2,
      hasWebsite: true,
    });
    expect(companyPagePayload([row({})]).extras).toEqual({
      licenceNumberCount: 0,
      hasWebsite: false,
    });
  });
});
