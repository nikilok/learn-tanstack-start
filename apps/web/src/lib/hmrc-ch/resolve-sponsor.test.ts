import { describe, expect, test } from 'bun:test';

import { resolveOneSponsor } from './resolve-sponsor';

type SearchItem = {
  company_number: string;
  title: string;
  company_status?: string;
  address?: { locality?: string; region?: string };
};

/** Ordered route table: first prefix match wins; unmatched paths return null. */
function makeFetch(routes: [string, unknown][]) {
  const calls: string[] = [];
  const fetchApi = async (path: string): Promise<unknown | null> => {
    calls.push(path);
    for (const [prefix, payload] of routes) {
      if (path.startsWith(prefix)) return payload;
    }
    return null;
  };
  return { fetchApi, calls };
}

const noLocation = { townCity: null, county: null };

describe('resolveOneSponsor — Tier A2 squash matches', () => {
  test('punctuation-variant name resolves as exact_squash without Tier-B fetches', async () => {
    const items: SearchItem[] = [
      {
        company_number: '11758030',
        title: 'JSB LIMITED',
        company_status: 'active',
      },
      {
        company_number: '08065565',
        title: 'J S B HAULAGE LIMITED',
        company_status: 'active',
      },
    ];
    const { fetchApi, calls } = makeFetch([
      ['/search/companies', { items }],
      [
        '/company/08065565',
        {
          company_number: '08065565',
          company_name: 'J S B HAULAGE LIMITED',
          company_status: 'active',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'JSB Haulage LTD',
      noLocation,
      fetchApi,
    );

    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.companyNumber).toBe('08065565');
    expect(result.matchMethod).toBe('exact_squash');
    expect(result.matchScore).toBe(0.98);
    // 1 search + 1 winner-profile fetch — squash wins from search items alone,
    // so no Tier-B profile scanning happened.
    expect(calls).toHaveLength(2);
  });

  test('active squash variant beats a dissolved exact namesake', async () => {
    const items: SearchItem[] = [
      {
        company_number: '00000001',
        title: 'ACME TRADING LIMITED',
        company_status: 'dissolved',
      },
      {
        company_number: '00000002',
        title: 'A.C.M.E. TRADING LIMITED',
        company_status: 'active',
      },
    ];
    const { fetchApi } = makeFetch([
      ['/search/companies', { items }],
      [
        '/company/00000002',
        {
          company_number: '00000002',
          company_name: 'A.C.M.E. TRADING LIMITED',
          company_status: 'active',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'Acme Trading Limited',
      noLocation,
      fetchApi,
    );

    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.companyNumber).toBe('00000002');
    expect(result.matchMethod).toBe('exact_squash');
  });
});

describe('resolveOneSponsor — embedded company-number hint', () => {
  test('hinted company resolves even when search returns nothing', async () => {
    const { fetchApi, calls } = makeFetch([
      ['/search/companies', { items: [] }],
      [
        '/company/10843126',
        {
          company_number: '10843126',
          company_name: 'JIREH HOMECARE LIMITED',
          company_status: 'active',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'JIREH HOMECARE LIMITED (Co Reg: 10843126)',
      noLocation,
      fetchApi,
    );

    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.companyNumber).toBe('10843126');
    expect(result.matchMethod).toBe('exact');
    // 1 search + 1 hint fetch; the winner's profile is already in hand.
    expect(calls).toHaveLength(2);
  });

  test('a bogus hint that matches no tier just loses', async () => {
    const { fetchApi } = makeFetch([
      ['/search/companies', { items: [] }],
      [
        '/company/99999999',
        {
          company_number: '99999999',
          company_name: 'ENTIRELY UNRELATED WIDGETS LIMITED',
          company_status: 'active',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'JIREH HOMECARE LIMITED (Co Reg: 99999999)',
      noLocation,
      fetchApi,
    );

    expect(result.verdict).toBe('no_match');
  });
});

describe('resolveOneSponsor — Tier D fuzzy with locality gate', () => {
  const items: SearchItem[] = [
    {
      company_number: '05678901',
      title: 'MADNI FOOD PRODUCTS LTD',
      company_status: 'active',
      address: { locality: 'Leicester' },
    },
  ];
  const routes: [string, unknown][] = [
    ['/search/companies', { items }],
    [
      '/company/05678901',
      {
        company_number: '05678901',
        company_name: 'MADNI FOOD PRODUCTS LTD',
        company_status: 'active',
        registered_office_address: { locality: 'Leicester' },
      },
    ],
  ];

  test('typo name resolves as fuzzy_edit when locality corroborates', async () => {
    const { fetchApi } = makeFetch(routes);

    const result = await resolveOneSponsor(
      'Madani Food Products Ltd',
      { townCity: 'Leicester', county: null },
      fetchApi,
    );

    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.matchMethod).toBe('fuzzy_edit');
    expect(result.companyNumber).toBe('05678901');
    expect(result.matchScore).toBe(0.9);
  });

  test('same typo name stays no_match without locality corroboration', async () => {
    const { fetchApi } = makeFetch(routes);

    const result = await resolveOneSponsor(
      'Madani Food Products Ltd',
      noLocation,
      fetchApi,
    );

    expect(result.verdict).toBe('no_match');
  });

  test('dissolved candidates never fuzzy-match', async () => {
    const dissolved = [{ ...items[0], company_status: 'dissolved' }];
    const { fetchApi } = makeFetch([
      ['/search/companies', { items: dissolved }],
      [
        '/company/05678901',
        {
          company_number: '05678901',
          company_name: 'MADNI FOOD PRODUCTS LTD',
          company_status: 'dissolved',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'Madani Food Products Ltd',
      { townCity: 'Leicester', county: null },
      fetchApi,
    );

    expect(result.verdict).toBe('no_match');
  });
});

describe('resolveOneSponsor — query normalisation', () => {
  test('the search query is normalised; comparisons still use the raw name', async () => {
    const { fetchApi, calls } = makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: '07654321',
              title: 'LEAF.FM LTD',
              company_status: 'active',
            },
          ],
        },
      ],
      [
        '/company/07654321',
        {
          company_number: '07654321',
          company_name: 'LEAF.FM LTD',
          company_status: 'active',
        },
      ],
    ]);

    const result = await resolveOneSponsor(
      'Leaf.fm, ltd',
      noLocation,
      fetchApi,
    );

    expect(calls[0]).toContain(`q=${encodeURIComponent('Leaf fm ltd')}`);
    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    // "LEAF.FM," vs "LEAF.FM" fails byte-exact Tier A; squash recovers it.
    expect(result.matchMethod).toBe('exact_squash');
    expect(result.queryUsed).toBe('Leaf fm ltd');
  });
});
