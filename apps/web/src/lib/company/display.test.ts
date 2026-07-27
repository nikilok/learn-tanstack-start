import { describe, expect, test } from 'bun:test';

import {
  type CompanyDisplayInput,
  deriveCompanyDisplay,
  formerCompanyNames,
  registeredLocation,
} from './display.ts';
import type { LicenceRow } from './licences.ts';

// deriveCompanyDisplay is the single source for the visible page copy, the meta
// description and the JSON-LD. Every value it returns is published, so these
// cases pin the ones that previously drifted or leaked another entity's data.

const licence = (over: Partial<LicenceRow>): LicenceRow => ({
  organisationName: 'ACME LTD',
  companyNumber: '01111111',
  typeRating: 'Worker (A rating)',
  route: 'Skilled Worker',
  sponsorLicenceNumber: null,
  ...over,
});

const derive = (input: CompanyDisplayInput) => deriveCompanyDisplay(input);

describe('deriveCompanyDisplay — naming', () => {
  test('leads with the Companies House name, which HMRC may hold stale', () => {
    const d = derive({
      sponsor: { licences: [licence({ organisationName: 'ACME LTD' })] },
      profile: { company_name: 'ACME TRADING LIMITED' },
    });
    expect(d.name).toBe('Acme Trading Limited');
    expect(d.rawName).toBe('ACME TRADING LIMITED');
  });

  test('falls back to the HMRC name when there is no CH profile', () => {
    const d = derive({
      sponsor: { licences: [licence({ organisationName: 'ACME LTD' })] },
    });
    // "LTD" stays capitalised: titleCase force-uppercases known acronyms.
    expect(d.name).toBe('Acme LTD');
  });

  test('does not repeat a case-variant alias after title-casing', () => {
    // "ACME SUPPORT LTD" and "Acme Support Ltd" both title-case to the same
    // string; deduping before that produced "…as Acme Support Ltd and Acme
    // Support Ltd" in the page copy and the JSON-LD alternateName.
    const d = derive({
      sponsor: {
        licences: [
          licence({ organisationName: 'ACME SUPPORT LTD' }),
          licence({
            organisationName: 'Acme Support Ltd',
            route: 'Creative Worker',
          }),
        ],
      },
      profile: { company_name: 'ACME LIMITED' },
    });
    expect(d.registeredNames).toEqual(['Acme Support LTD']);
    expect(d.registeredAs).toBe('Acme Support LTD');
  });

  test('omits an alias that is just the current name in another case', () => {
    const d = derive({
      sponsor: { licences: [licence({ organisationName: 'ACME LTD' })] },
      profile: { company_name: 'Acme Ltd' },
    });
    expect(d.registeredNames).toEqual([]);
    expect(d.registeredAs).toBe('');
  });
});

describe('deriveCompanyDisplay — rating pairing', () => {
  const mixed: CompanyDisplayInput = {
    sponsor: {
      licences: [
        licence({ route: 'Skilled Worker', typeRating: 'Worker (B rating)' }),
        licence({
          route: 'Global Business Mobility: Senior or Specialist Worker',
          typeRating: 'Worker (A rating)',
        }),
      ],
    },
  };

  test('spells out which rating belongs to which route', () => {
    const d = derive(mixed);
    expect(d.licencesVary).toBe(true);
    expect(d.licencePhrases).toEqual([
      'Worker (B Rating) for Skilled Worker',
      'Worker (A Rating) for Global Business Mobility: Senior Or Specialist Worker',
    ]);
  });

  test('treats a Worker vs Temporary Worker split as differing', () => {
    // Both phrase as "A-rated", so comparing the shorthand suppressed the
    // pairing and the page claimed a single uniform rating.
    const d = derive({
      sponsor: {
        licences: [
          licence({ route: 'Skilled Worker', typeRating: 'Worker (A rating)' }),
          licence({
            route: 'Creative Worker',
            typeRating: 'Temporary Worker (A rating)',
          }),
        ],
      },
    });
    expect(d.licencesVary).toBe(true);
  });

  test('keeps the short phrasing when every route shares one rating', () => {
    const d = derive({
      sponsor: {
        licences: [
          licence({ route: 'Skilled Worker' }),
          licence({ route: 'Creative Worker' }),
        ],
      },
    });
    expect(d.licencesVary).toBe(false);
    expect(d.ratingText).toBe('A-rated');
  });

  test('routeLicences pairs each route with its own rating', () => {
    expect(derive(mixed).routeLicences).toEqual([
      { route: 'Skilled Worker', ratings: ['Worker (B rating)'] },
      {
        route: 'Global Business Mobility: Senior or Specialist Worker',
        ratings: ['Worker (A rating)'],
      },
    ]);
  });
});

describe('deriveCompanyDisplay — unmapped pools stay whole', () => {
  test('keeps every licence of a spacing-variant of ONE organisation', () => {
    // LIVE production case: /company/university-of-leeds-human-resources pools
    // "University of Leeds (Human Resources)" and "University of Leeds(Human
    // Resources)" — the same body, differing only by a missing space. A guard
    // keyed on normalizeName treated them as two entities and deleted 3 of the
    // university's 4 real routes. No normalisation can separate this from two
    // genuinely distinct namesakes, so the pool is never split by name.
    const d = derive({
      sponsor: {
        licences: [
          licence({
            organisationName: 'University of Leeds (Human Resources)',
            companyNumber: null,
            route: 'Skilled Worker',
            typeRating: 'Worker (A rating)',
            sponsorLicenceNumber: '4DGMEKTY8',
          }),
          ...[
            'Creative Worker',
            'Government Authorised Exchange',
            'International Agreement',
          ].map((route) =>
            licence({
              organisationName: 'University of Leeds(Human Resources)',
              companyNumber: null,
              route,
              typeRating: 'Temporary Worker (A rating)',
              sponsorLicenceNumber: '20UVVU0W8',
            }),
          ),
        ],
      },
    });
    expect(d.routes).toHaveLength(4);
    expect(d.routes).toContain('Government Authorised Exchange');
    expect(d.ratings).toContain('Temporary Worker (A rating)');
    expect(d.licences).toHaveLength(4);
  });

  test('a DIFFERENT mapped company is separated upstream, not here', () => {
    // poolForPrimary (server side) splits by company number, and the ingest
    // gives the loser its own suffixed slug — deriveCompanyDisplay trusts that.
    const d = derive({
      sponsor: {
        licences: [
          licence({
            organisationName: 'SK Associates Ltd',
            companyNumber: '04177190',
          }),
        ],
      },
    });
    expect(d.licences).toHaveLength(1);
  });
});

describe('deriveCompanyDisplay — location and industry', () => {
  test('prefers locality, falling back to address line 2', () => {
    expect(
      derive({
        sponsor: { licences: [licence({})] },
        profile: {
          registered_office_address: {
            locality: 'London',
            region: 'Greater London',
          },
        },
      }).location,
    ).toBe('London, Greater London');
    expect(
      derive({
        sponsor: { licences: [licence({})] },
        profile: { registered_office_address: { address_line_2: 'Soho' } },
      }).location,
    ).toBe('Soho');
  });

  test('joins SIC descriptions and tolerates a missing profile', () => {
    expect(
      derive({
        sponsor: { licences: [licence({})] },
        profile: {
          sicDescriptions: [
            { code: '62020', description: 'IT consultancy' },
            { code: '62012', description: 'Software development' },
          ],
        },
      }).industry,
    ).toBe('IT consultancy, Software development');
    expect(
      derive({ sponsor: { licences: [licence({})] } }).industry,
    ).toBeUndefined();
  });

  test('keeps the SIC code/description pairs, empty when there is no profile', () => {
    const pairs = [{ code: '62020', description: 'IT consultancy' }];
    expect(
      derive({
        sponsor: { licences: [licence({})] },
        profile: { sicDescriptions: pairs },
      }).sicEntries,
    ).toEqual(pairs);
    // The page renders off .length — an undefined default would throw.
    expect(derive({ sponsor: { licences: [licence({})] } }).sicEntries).toEqual(
      [],
    );
  });

  test('survives an empty licence list without throwing', () => {
    const d = derive({ sponsor: { licences: [] } });
    expect(d.name).toBe('');
    expect(d.routes).toEqual([]);
    expect(d.licencesVary).toBe(false);
  });
});

describe('formerCompanyNames', () => {
  test('drops the current name, blanks, and normalised duplicates', () => {
    expect(
      formerCompanyNames(
        [
          'Acme Limited',
          'ACME LTD',
          '',
          'Older Name Ltd',
          'Older Name Limited',
        ],
        'Acme Ltd',
      ),
      // "Acme Limited"/"ACME LTD" normalise to the current name; the two Older
      // Name spellings collapse to the first seen.
    ).toEqual(['Older Name Ltd']);
  });

  test('returns an empty list when there are no previous names', () => {
    expect(formerCompanyNames(undefined, 'Acme Ltd')).toEqual([]);
  });
});

describe('registeredLocation', () => {
  test('returns an empty string when there is no usable address', () => {
    expect(registeredLocation(null)).toBe('');
    expect(registeredLocation(undefined)).toBe('');
    expect(registeredLocation({})).toBe('');
  });
});
