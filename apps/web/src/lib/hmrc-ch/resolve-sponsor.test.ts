import { describe, expect, test } from 'bun:test';

import type { ChResponse } from './ch-lookup';
import { resolveOneSponsor } from './resolve-sponsor';

type SearchItem = {
  company_number: string;
  title: string;
  company_status?: string;
  address?: { locality?: string; region?: string };
};

/** A route that answers with a failed call instead of a payload. */
class Failed {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

/** Ordered route table: first prefix match wins; unmatched paths answer 404. */
function makeFetch(routes: [string, unknown][]) {
  const calls: string[] = [];
  const fetchApi = async (path: string): Promise<ChResponse> => {
    calls.push(path);
    for (const [prefix, answer] of routes) {
      if (!path.startsWith(prefix)) continue;
      return answer instanceof Failed
        ? { ok: false, status: answer.status }
        : { ok: true, data: answer };
    }
    return { ok: false, status: 404 };
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

describe('resolveOneSponsor — Companies House gaps', () => {
  // The active-status preference's own example: HMRC lists 3DC LTD; search
  // returns the dissolved exact namesake and the active company renamed from
  // 3DC LTD.
  const items: SearchItem[] = [
    {
      company_number: '00000003',
      title: '3DC LIMITED',
      company_status: 'dissolved',
    },
    {
      company_number: '00000004',
      title: 'SHOP3D LTD',
      company_status: 'active',
    },
  ];
  const dissolved = {
    company_number: '00000003',
    company_name: '3DC LIMITED',
    company_status: 'dissolved',
  };
  const renamed = {
    company_number: '00000004',
    company_name: 'SHOP3D LTD',
    company_status: 'active',
    previous_company_names: [{ name: '3DC LTD' }],
  };

  test('a 429 on the renamed company never lets the dissolved namesake verify', async () => {
    const { fetchApi } = makeFetch([
      ['/search/companies', { items }],
      ['/company/00000003', dissolved],
      ['/company/00000004', new Failed(429)],
    ]);
    expect(await resolveOneSponsor('3DC LTD', noLocation, fetchApi)).toEqual({
      verdict: 'unavailable',
    });
  });

  test('a 404 on the renamed company is evidence, so the dissolved namesake verifies', async () => {
    // What the lost probe above used to be read as: a mapping kept for good.
    const { fetchApi } = makeFetch([
      ['/search/companies', { items }],
      ['/company/00000003', dissolved],
    ]);
    expect(
      await resolveOneSponsor('3DC LTD', noLocation, fetchApi),
    ).toMatchObject({ verdict: 'verified', companyNumber: '00000003' });
  });

  test('with every answer in, the renamed company verifies by its previous name', async () => {
    const { fetchApi } = makeFetch([
      ['/search/companies', { items }],
      ['/company/00000003', dissolved],
      ['/company/00000004', renamed],
    ]);
    expect(
      await resolveOneSponsor('3DC LTD', noLocation, fetchApi),
    ).toMatchObject({
      verdict: 'verified',
      companyNumber: '00000004',
      matchMethod: 'previous_name',
    });
  });

  test('stops at the first failed call', async () => {
    const { fetchApi, calls } = makeFetch([
      ['/search/companies', new Failed(503)],
    ]);
    expect(
      await resolveOneSponsor('ACME TRADING LTD', noLocation, fetchApi),
    ).toEqual({ verdict: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  test('an empty search is still a definitive no_match', async () => {
    const { fetchApi } = makeFetch([['/search/companies', { items: [] }]]);
    expect(
      await resolveOneSponsor('ACME TRADING LTD', noLocation, fetchApi),
    ).toMatchObject({ verdict: 'no_match' });
  });

  test('a 404 on a probe is evidence, not a gap', async () => {
    const { fetchApi } = makeFetch([
      ['/search/companies', { items: [items[1]] }],
    ]);
    expect(
      await resolveOneSponsor('3DC LTD', noLocation, fetchApi),
    ).toMatchObject({ verdict: 'no_match' });
  });

  test('a failed fetch of the embedded company number is unavailable, not a lost hint', async () => {
    const { fetchApi } = makeFetch([
      ['/search/companies', { items: [] }],
      ['/company/10843126', new Failed(503)],
    ]);
    expect(
      await resolveOneSponsor(
        'JIREH HOMECARE LIMITED (Co Reg: 10843126)',
        noLocation,
        fetchApi,
      ),
    ).toEqual({ verdict: 'unavailable' });
  });

  test("a failed fetch of the winner's profile is unavailable, not no_match", async () => {
    const { fetchApi } = makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: '08065565',
              title: 'J S B HAULAGE LIMITED',
              company_status: 'active',
            },
          ],
        },
      ],
      ['/company/08065565', new Failed(500)],
    ]);
    expect(
      await resolveOneSponsor('JSB Haulage LTD', noLocation, fetchApi),
    ).toEqual({ verdict: 'unavailable' });
  });
});

describe('resolveOneSponsor — name-only matches need the place', () => {
  /** One exact namesake of a bare register name, with the given status and office. */
  function namesake(status: string, office: Record<string, string>) {
    return makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: '00000042',
              title: 'NORTHGATE BAKERY LIMITED',
              company_status: status,
            },
          ],
        },
      ],
      [
        '/company/00000042',
        {
          company_number: '00000042',
          company_name: 'NORTHGATE BAKERY LIMITED',
          company_status: status,
          registered_office_address: office,
        },
      ],
    ]);
  }
  const exeter = { townCity: 'Exeter', county: 'Devon' };

  test('a bare name on a namesake in another town goes to review', async () => {
    const { fetchApi } = namesake('active', {
      address_line_1: '4 Mill Lane',
      locality: 'Leeds',
      region: 'West Yorkshire',
    });
    const result = await resolveOneSponsor(
      'Northgate Bakery',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('human_review');
    if (result.verdict !== 'human_review') return;
    expect(result.contenders.map((c) => c.candidate.company_number)).toEqual([
      '00000042',
    ]);
  });

  test('the same namesake in the sponsor town verifies', async () => {
    const { fetchApi } = namesake('active', {
      address_line_1: '4 Mill Lane',
      locality: 'Exeter',
    });
    const result = await resolveOneSponsor(
      'Northgate Bakery',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.companyNumber).toBe('00000042');
    expect(result.matchMethod).toBe('exact');
  });

  test('an active namesake in the sponsor county verifies', async () => {
    const { fetchApi } = namesake('active', {
      locality: 'Tiverton',
      region: 'Devon',
    });
    const result = await resolveOneSponsor(
      'Northgate Bakery',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('verified');
  });

  test('a dissolved namesake in the sponsor county goes to review', async () => {
    const { fetchApi } = namesake('dissolved', {
      locality: 'Tiverton',
      region: 'Devon',
    });
    const result = await resolveOneSponsor(
      'Northgate Bakery',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('human_review');
  });

  test('a register name with its own suffix verifies wherever the office is', async () => {
    const { fetchApi } = namesake('active', { locality: 'Leeds' });
    const result = await resolveOneSponsor(
      'Northgate Bakery Ltd',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('verified');
  });

  test("a register name that carries the company's number verifies wherever the office is", async () => {
    const { fetchApi } = namesake('active', { locality: 'Leeds' });
    const result = await resolveOneSponsor(
      'Northgate Bakery (Co Reg: 00000042)',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;
    expect(result.companyNumber).toBe('00000042');
  });

  test("another company's number in the register name does not vouch for the namesake", async () => {
    const { fetchApi } = namesake('active', { locality: 'Leeds' });
    const result = await resolveOneSponsor(
      'Northgate Bakery (Co Reg: 00000077)',
      exeter,
      fetchApi,
    );
    expect(result.verdict).toBe('human_review');
    if (result.verdict !== 'human_review') return;
    expect(result.queryUsed).not.toContain('00000077');
  });
});

// The JPMorgan, Caixa and Dennison answers are Companies House's own, recorded 2026-11-26.
describe('resolveOneSponsor — an overseas company lands on its UK establishment', () => {
  const JPM = 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION';
  const london = { townCity: 'London', county: null };
  // Three records carry the name: only the overseas company is `active`.
  const jpmSearch: SearchItem[] = [
    {
      company_number: 'OE032355',
      title: JPM,
      company_status: 'registered',
      address: { locality: 'Delaware' },
    },
    {
      company_number: 'FC004891',
      title: JPM,
      company_status: 'active',
      address: { locality: 'Ohio 43240', region: 'United States' },
    },
    {
      company_number: 'BR000746',
      title: JPM,
      company_status: 'open',
      address: { locality: 'London', region: 'Canary Wharf' },
    },
  ];
  const jpmOverseas = {
    company_number: 'FC004891',
    company_name: JPM,
    company_status: 'active',
    type: 'oversea-company',
    registered_office_address: {
      address_line_1: '1111 Polaris Parkway',
      address_line_2: 'Columbus',
      locality: 'Ohio 43240',
      region: 'United States',
      country: 'United States',
    },
  };
  const jpmEstablishment = {
    company_number: 'BR000746',
    company_name: JPM,
    company_status: 'open',
    type: 'uk-establishment',
    registered_office_address: {
      address_line_1: '25 Bank Street',
      locality: 'London',
      region: 'Canary Wharf',
      postal_code: 'E14 5JP',
    },
    branch_company_details: {
      business_activity: 'Banking',
      parent_company_name: JPM,
      parent_company_number: 'FC004891',
    },
  };
  const jpmListed = {
    kind: 'related-companies',
    items: [
      {
        company_name: JPM,
        company_number: 'BR000746',
        company_status: 'open',
        locality: 'London',
        links: { company: '/company/BR000746' },
      },
    ],
  };
  const LIST = '/company/FC004891/uk-establishments';

  /** JPMorgan's records as routes: `over` first, and the list ahead of the profile whose path it extends. */
  const jpmRoutes = (
    over: [string, unknown][] = [],
    items: SearchItem[] = jpmSearch,
  ): [string, unknown][] => [
    ...over,
    ['/search/companies', { items }],
    [LIST, jpmListed],
    ['/company/FC004891', jpmOverseas],
    ['/company/BR000746', jpmEstablishment],
  ];

  test('JPMorgan Chase Bank (FC004891 active, BR000746 open, sponsor in London) lands on BR000746', async () => {
    const { fetchApi, calls } = makeFetch(jpmRoutes());
    const result = await resolveOneSponsor(
      'JPMorgan Chase Bank, National Association',
      london,
      fetchApi,
    );
    expect(result).toEqual({
      verdict: 'verified',
      companyNumber: 'BR000746',
      matchMethod: 'exact',
      matchScore: 1,
      queryUsed: 'JPMorgan Chase Bank National Association',
      profile: jpmEstablishment,
      overseas: { companyNumber: 'FC004891', link: 'followed' },
    });
    expect(calls.slice(1)).toEqual([
      '/company/FC004891',
      LIST,
      '/company/BR000746',
    ]);
  });

  test('it lands there whether or not the search lists the establishment, and whatever the town', async () => {
    const { fetchApi } = makeFetch(jpmRoutes([], jpmSearch.slice(0, 2)));
    const result = await resolveOneSponsor(
      'JPMorgan Chase Bank, National Association',
      { townCity: 'Bournemouth', county: 'Dorset' },
      fetchApi,
    );
    expect(result).toMatchObject({
      verdict: 'verified',
      companyNumber: 'BR000746',
      matchMethod: 'exact',
    });
  });

  test('the method and score stay those of the name match: a squashed name', async () => {
    const { fetchApi } = makeFetch(jpmRoutes());
    const result = await resolveOneSponsor(
      'JPMorgan Chase Bank National Association',
      london,
      fetchApi,
    );
    expect(result).toMatchObject({
      verdict: 'verified',
      companyNumber: 'BR000746',
      matchMethod: 'exact_squash',
      matchScore: 0.98,
    });
  });

  // An invented overseas company, numbered SF as three of the real ones are: its type says what it is, not its prefix.
  const quillmere = (name: string, previous: string[] = []) => ({
    company_number: 'SF000123',
    company_name: name,
    company_status: 'active',
    type: 'oversea-company',
    registered_office_address: { locality: 'Wilmington' },
    previous_company_names: previous.map((p) => ({ name: p })),
  });
  const quillmereRoutes = (
    overseas: ReturnType<typeof quillmere>,
  ): [string, unknown][] => [
    [
      '/search/companies',
      {
        items: [
          {
            company_number: 'SF000123',
            title: overseas.company_name,
            company_status: 'active',
          },
        ],
      },
    ],
    [
      '/company/SF000123/uk-establishments',
      { items: [{ company_number: 'BR000123', company_status: 'open' }] },
    ],
    ['/company/SF000123', overseas],
    [
      '/company/BR000123',
      {
        company_number: 'BR000123',
        company_name: 'QUILLMERE UK BRANCH',
        company_status: 'open',
        type: 'uk-establishment',
        branch_company_details: { parent_company_number: 'SF000123' },
      },
    ],
  ];

  test.each([
    [
      'a previous name',
      'Quillmere Trust Company',
      quillmere('QUILLMERE BANK INC', ['QUILLMERE TRUST COMPANY']),
      'previous_name',
      0.95,
    ],
    [
      'most of its words',
      'Quillmere Global Bank Trust Services Group Inc',
      quillmere('QUILLMERE GLOBAL BANK TRUST SERVICES INC'),
      'token_sim',
      6 / 7,
    ],
  ] as const)(
    'the method and score stay those of the name match: %s',
    async (_label, sponsor, overseas, method, score) => {
      const { fetchApi } = makeFetch(quillmereRoutes(overseas));
      const result = await resolveOneSponsor(sponsor, noLocation, fetchApi);
      expect(result.verdict).toBe('verified');
      if (result.verdict !== 'verified') return;
      expect(result.companyNumber).toBe('BR000123');
      expect(result.matchMethod).toBe(method);
      expect(result.matchScore).toBeCloseTo(score, 10);
      expect(result.overseas).toEqual({
        companyNumber: 'SF000123',
        link: 'followed',
      });
    },
  );

  test('Caixa Geral de Depositos (FC023485, open in London and Manchester, sponsor in London) stays on FC023485', async () => {
    const overseas = {
      company_number: 'FC023485',
      company_name: 'CAIXA GERAL DE DEPOSITOS, S.A.',
      company_status: 'active',
      type: 'oversea-company',
      registered_office_address: {
        address_line_1: 'Caixa Geral De Depositos, Sa',
        address_line_2: 'Avenida Dom Joao Ii, No 1',
        locality: 'Lisboa',
        region: 'Lisboa 1998-038',
        country: 'Portugal',
      },
    };
    const { fetchApi, calls } = makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: 'FC023485',
              title: 'CAIXA GERAL DE DEPOSITOS, S.A.',
              company_status: 'active',
              address: { locality: 'Lisboa', region: 'Lisboa 1998-038' },
            },
            {
              company_number: 'BR006261',
              title: 'CAIXA GERAL DE DEPOSITOS, S.A., LONDON OFFICE',
              company_status: 'open',
              address: { locality: 'London' },
            },
            {
              company_number: 'BR028851',
              title: 'CAIXA GERAL DE DEPOSITOS, S.A.,MANCHESTER OFFICE',
              company_status: 'open',
              address: { locality: 'Manchester', region: 'Oxford Street' },
            },
          ],
        },
      ],
      [
        '/company/FC023485/uk-establishments',
        {
          kind: 'related-companies',
          items: [
            {
              company_name: 'CAIXA GERAL DE DEPOSITOS, S.A., LONDON OFFICE',
              company_number: 'BR006261',
              company_status: 'open',
              locality: 'London',
            },
            {
              company_name: 'CAIXA GERAL DE DEPOSITOS, S.A.,MANCHESTER OFFICE',
              company_number: 'BR028851',
              company_status: 'open',
              locality: 'Manchester',
            },
          ],
        },
      ],
      ['/company/FC023485', overseas],
    ]);
    const result = await resolveOneSponsor(
      'Caixa Geral de Depositos, S.A.',
      london,
      fetchApi,
    );
    expect(result).toMatchObject({
      verdict: 'verified',
      companyNumber: 'FC023485',
      matchMethod: 'exact',
      profile: overseas,
      overseas: { companyNumber: 'FC023485', link: 'several' },
    });
    // No town picks between them: neither establishment's profile is asked for.
    expect(calls.slice(1)).toEqual([
      '/company/FC023485',
      '/company/FC023485/uk-establishments',
    ]);
  });

  // Its Belfast namesake NI017855 matches the name too; the town is taken as Lancaster, where FC021303's office is.
  test.each([
    [
      'an empty list, as Companies House answers',
      { kind: 'related-companies', items: [] },
    ],
    ['a 404', new Failed(404)],
    ['a list that is no array', { items: 'none' }],
  ])(
    'Dennison Trailers (FC021303, no establishment) stays on FC021303: %s',
    async (_label, listed) => {
      const overseas = {
        company_number: 'FC021303',
        company_name: 'DENNISON TRAILERS LIMITED',
        company_status: 'active',
        type: 'oversea-company',
        registered_office_address: {
          address_line_2: 'Dennison Trailers Ltd',
          locality: 'Caton Road',
          region: 'Lancaster',
          postal_code: 'LA1 3PE',
          country: 'Northern Ireland',
        },
      };
      const { fetchApi } = makeFetch([
        [
          '/search/companies',
          {
            items: [
              {
                company_number: 'FC021303',
                title: 'DENNISON TRAILERS LIMITED',
                company_status: 'active',
                address: { locality: 'Caton Road', region: 'Lancaster' },
              },
              {
                company_number: 'NI017855',
                title: 'DENNISON TRAILERS LIMITED',
                company_status: 'active',
                address: { locality: '21 Old Channel Road', region: 'Belfast' },
              },
            ],
          },
        ],
        ['/company/FC021303/uk-establishments', listed],
        ['/company/FC021303', overseas],
      ]);
      const result = await resolveOneSponsor(
        'Dennison Trailers Limited',
        { townCity: 'Lancaster', county: 'Lancashire' },
        fetchApi,
      );
      expect(result).toMatchObject({
        verdict: 'verified',
        companyNumber: 'FC021303',
        matchMethod: 'exact',
        profile: overseas,
        overseas: { companyNumber: 'FC021303', link: 'none' },
      });
    },
  );

  test.each([
    ['the establishments list', LIST],
    ["the establishment's profile", '/company/BR000746'],
  ])(
    '%s failing to answer leaves no verdict to store',
    async (_label, path) => {
      const { fetchApi } = makeFetch(jpmRoutes([[path, new Failed(502)]]));
      const result = await resolveOneSponsor(
        'JPMorgan Chase Bank, National Association',
        london,
        fetchApi,
      );
      expect(result).toEqual({ verdict: 'unavailable' });
    },
  );

  test.each([
    ['closed', { ...jpmEstablishment, company_status: 'closed' }],
    [
      "another company's",
      {
        ...jpmEstablishment,
        branch_company_details: { parent_company_number: 'FC000002' },
      },
    ],
    [
      'without a parent',
      { ...jpmEstablishment, branch_company_details: undefined },
    ],
    ['for another number', { ...jpmEstablishment, company_number: 'BR000002' }],
    ['missing', new Failed(404)],
  ])(
    'an establishment whose own profile is %s moves nothing: the overseas record stays',
    async (_label, given) => {
      const { fetchApi } = makeFetch(jpmRoutes([['/company/BR000746', given]]));
      const result = await resolveOneSponsor(
        'JPMorgan Chase Bank, National Association',
        london,
        fetchApi,
      );
      expect(result).toMatchObject({
        verdict: 'verified',
        companyNumber: 'FC004891',
        matchMethod: 'exact',
        profile: jpmOverseas,
        overseas: { companyNumber: 'FC004891', link: 'unconfirmed' },
      });
    },
  );

  test("a profile already in hand is not asked for again: the establishment's number in the register name", async () => {
    const { fetchApi, calls } = makeFetch(jpmRoutes());
    const result = await resolveOneSponsor(
      'JPMorgan Chase Bank, National Association (Co Reg: BR000746)',
      london,
      fetchApi,
    );
    expect(result).toMatchObject({
      verdict: 'verified',
      companyNumber: 'BR000746',
    });
    expect(calls.filter((path) => path === '/company/BR000746')).toHaveLength(
      1,
    );
  });

  test('a match held for want of the place asks for no establishments', async () => {
    const { fetchApi, calls } = makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: 'FC000456',
              title: 'QUILLMERE LIMITED',
              company_status: 'active',
            },
          ],
        },
      ],
      [
        '/company/FC000456',
        {
          company_number: 'FC000456',
          company_name: 'QUILLMERE LIMITED',
          company_status: 'active',
          type: 'oversea-company',
          registered_office_address: { locality: 'Dublin' },
        },
      ],
    ]);
    const result = await resolveOneSponsor('Quillmere', london, fetchApi);
    expect(result.verdict).toBe('human_review');
    expect(calls.some((path) => path.includes('uk-establishments'))).toBe(
      false,
    );
  });

  test('a company the register does not type as overseas asks for none, whatever its number', async () => {
    const { fetchApi, calls } = makeFetch([
      [
        '/search/companies',
        {
          items: [
            {
              company_number: 'FC000789',
              title: 'QUILLMERE HOLDINGS LIMITED',
              company_status: 'active',
            },
          ],
        },
      ],
      [
        '/company/FC000789',
        {
          company_number: 'FC000789',
          company_name: 'QUILLMERE HOLDINGS LIMITED',
          company_status: 'active',
          type: 'ltd',
        },
      ],
    ]);
    const result = await resolveOneSponsor(
      'Quillmere Holdings Limited',
      noLocation,
      fetchApi,
    );
    expect(result).toMatchObject({
      verdict: 'verified',
      companyNumber: 'FC000789',
    });
    if (result.verdict !== 'verified') return;
    expect(result.overseas).toBeUndefined();
    expect(calls).toEqual([calls[0], '/company/FC000789']);
  });
});
