import { describe, expect, test } from 'bun:test';

import {
  cardLicence,
  identitySafeLicences,
  type LicenceRow,
  poolForPrimary,
  routeLicences,
} from './licences.ts';

// Every case here is a bug that actually shipped or was caught in review during
// the slug-URL migration. The governing invariant: a rating is only ever shown
// against the route it is held on. Routes and ratings must never be presented
// as two independent lists, because every consumer that re-pairs them by order
// gets it wrong for companies rated differently per route.

// Real production data: Platinum Equity Advisors International (UK) Limited.
// Its Skilled Worker licence is B-rated while its GBM licence is A-rated, so
// sorting routes and ratings independently puts "A rating" beside the Skilled
// Worker chip — the live bug this suite exists to prevent.
const PLATINUM = {
  routes: [
    'Global Business Mobility: Senior or Specialist Worker',
    'Skilled Worker',
  ],
  typeRatings: ['Worker (A rating)', 'Worker (B rating)'],
  licences: [
    {
      route: 'Global Business Mobility: Senior or Specialist Worker',
      rating: 'Worker (A rating)',
    },
    { route: 'Skilled Worker', rating: 'Worker (B rating)' },
  ],
};

const row = (over: Partial<LicenceRow>): LicenceRow => ({
  organisationName: 'ACME LTD',
  companyNumber: '01111111',
  typeRating: 'Worker (A rating)',
  route: 'Skilled Worker',
  sponsorLicenceNumber: null,
  ...over,
});

describe('cardLicence — the rating belongs to the chip route', () => {
  test('shows the leading route’s OWN rating, not the best rating overall', () => {
    const { chipRoute, rating } = cardLicence(PLATINUM);
    expect(chipRoute).toBe('Skilled Worker');
    // The A rating belongs to the GBM licence; showing it here was the bug.
    expect(rating).toBe('Worker (B rating)');
  });

  test('Skilled Worker leads the chip, with the remaining routes counted', () => {
    const { chipRoute, extraRoutes } = cardLicence(PLATINUM);
    expect(chipRoute).toBe('Skilled Worker');
    expect(extraRoutes).toBe(1);
  });

  test('falls back to the unpaired list ONLY for pre-`licences` payloads', () => {
    const legacy = {
      routes: ['Skilled Worker'],
      typeRatings: ['Worker (A rating)'],
    };
    expect(cardLicence(legacy).rating).toBe('Worker (A rating)');
  });

  test('never borrows another route’s rating when the payload is inconsistent', () => {
    const inconsistent = {
      routes: ['Skilled Worker'],
      typeRatings: ['Worker (A rating)'],
      licences: [
        { route: 'Creative Worker', rating: 'Temporary Worker (B rating)' },
      ],
    };
    // No licence matches the chip route, so no rating may be claimed.
    expect(cardLicence(inconsistent).rating).toBe('');
  });

  test('degrades instead of throwing on an empty or partial payload', () => {
    expect(cardLicence({})).toEqual({
      chipRoute: '',
      rating: '',
      extraRoutes: 0,
    });
    expect(cardLicence({ routes: null, licences: null })).toEqual({
      chipRoute: '',
      rating: '',
      extraRoutes: 0,
    });
  });
});

describe('routeLicences — grouping keeps each route with its own rating', () => {
  test('pairs every route to the rating held on it', () => {
    expect(
      routeLicences([
        { route: 'Skilled Worker', typeRating: 'Worker (B rating)' },
        {
          route: 'Global Business Mobility: Senior or Specialist Worker',
          typeRating: 'Worker (A rating)',
        },
      ]),
    ).toEqual([
      { route: 'Skilled Worker', ratings: ['Worker (B rating)'] },
      {
        route: 'Global Business Mobility: Senior or Specialist Worker',
        ratings: ['Worker (A rating)'],
      },
    ]);
  });

  test('keeps the Worker vs Temporary Worker distinction the "A-rated" shorthand loses', () => {
    const grouped = routeLicences([
      { route: 'Skilled Worker', typeRating: 'Worker (A rating)' },
      {
        route: 'Global Business Mobility: Graduate Trainee',
        typeRating: 'Temporary Worker (A rating)',
      },
    ]);
    expect(grouped.map((g) => g.ratings[0])).toEqual([
      'Worker (A rating)',
      'Temporary Worker (A rating)',
    ]);
  });

  test('collapses duplicate rows for one route and orders ratings best-tier first', () => {
    const [only] = routeLicences([
      { route: 'Skilled Worker', typeRating: 'Worker (B rating)' },
      { route: 'Skilled Worker', typeRating: 'Worker (B rating)' },
      { route: 'Skilled Worker', typeRating: 'Worker (A rating)' },
    ]);
    expect(only.ratings).toEqual(['Worker (A rating)', 'Worker (B rating)']);
  });

  test('Skilled Worker leads regardless of input order', () => {
    const routes = routeLicences([
      { route: 'International Agreement', typeRating: 'Worker (A rating)' },
      { route: 'Skilled Worker', typeRating: 'Worker (A rating)' },
    ]).map((g) => g.route);
    expect(routes[0]).toBe('Skilled Worker');
  });
});

describe('poolForPrimary — a namesake slug never leaks another entity', () => {
  test('drops a DIFFERENT mapped company sharing the slug', () => {
    // "SK & Associates Ltd" and "SK Associates Ltd" both slugify alike but are
    // separate legal entities with separate company numbers.
    const pooled = poolForPrimary([
      row({ organisationName: 'SK Associates Ltd', companyNumber: '04177190' }),
      row({
        organisationName: 'SK & Associates Ltd',
        companyNumber: '04339349',
        route: 'Creative Worker',
      }),
    ]);
    expect(pooled).toHaveLength(1);
    expect(pooled[0].organisationName).toBe('SK Associates Ltd');
  });

  test('keeps the same company’s case-variant rows', () => {
    expect(
      poolForPrimary([
        row({ organisationName: 'ACME LTD' }),
        row({ organisationName: 'Acme Ltd', route: 'Creative Worker' }),
      ]),
    ).toHaveLength(2);
  });

  test('keeps unmapped rows, which are name-keyed and indistinguishable', () => {
    expect(
      poolForPrimary([
        row({ companyNumber: '01111111' }),
        row({ companyNumber: null, route: 'Creative Worker' }),
      ]),
    ).toHaveLength(2);
  });

  test('handles an empty pool', () => {
    expect(poolForPrimary([])).toEqual([]);
  });
});

describe('identitySafeLicences — unmapped namesakes stay separate', () => {
  test('drops a distinct unmapped entity’s rows from the primary’s page', () => {
    const safe = identitySafeLicences([
      row({ organisationName: 'Phoenix Consulting Ltd', companyNumber: null }),
      row({
        organisationName: 'Phoenix Consulting (UK)',
        companyNumber: null,
        sponsorLicenceNumber: 'OTHER-CO-LICENCE',
      }),
    ]);
    expect(safe).toHaveLength(1);
    // The other entity's licence number is a verifiable identifier; publishing
    // it under this company's heading was the bug.
    expect(safe[0].sponsorLicenceNumber).toBeNull();
  });

  test('keeps case/punctuation variants of ONE unmapped name', () => {
    expect(
      identitySafeLicences([
        row({ organisationName: 'ACME LTD', companyNumber: null }),
        row({
          organisationName: 'Acme Ltd',
          companyNumber: null,
          route: 'Creative Worker',
        }),
      ]),
    ).toHaveLength(2);
  });

  test('leaves a mapped pool untouched — poolForPrimary already vouched for it', () => {
    const mapped = [
      row({ organisationName: 'ACME LTD' }),
      row({ organisationName: 'Acme Trading Ltd', route: 'Creative Worker' }),
    ];
    expect(identitySafeLicences(mapped)).toHaveLength(2);
  });

  test('handles an empty pool', () => {
    expect(identitySafeLicences([])).toEqual([]);
  });
});
