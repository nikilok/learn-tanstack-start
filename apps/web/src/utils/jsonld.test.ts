import { describe, expect, test } from 'bun:test';

import { buildCompanyJsonLd } from './jsonld.ts';

// The machine-readable layer has to carry the route↔rating pairing too. An
// answer that lists routes and ratings separately is read positionally by
// crawlers and assistants, which inverts it for companies rated differently
// per route — the same defect as the visual one, with wider blast radius.

const base = {
  name: 'Acme Ltd',
  legalName: 'ACME LIMITED',
  location: 'London',
  canonicalUrl: 'https://sponsorsearch.co.uk/company/acme-ltd',
  homeUrl: 'https://sponsorsearch.co.uk',
};

/** Pull the FAQ answers out of the emitted blocks, keyed by question. */
function faqAnswers(blocks: Record<string, unknown>[]) {
  const faq = blocks.find((b) => b['@type'] === 'FAQPage') as {
    mainEntity: { name: string; acceptedAnswer: { text: string } }[];
  };
  return Object.fromEntries(
    faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
  );
}

function organization(blocks: Record<string, unknown>[]) {
  return blocks.find((b) => b['@type'] === 'Organization') as Record<
    string,
    unknown
  >;
}

const MIXED = [
  { route: 'Skilled Worker', ratings: ['Worker (B rating)'] },
  {
    route: 'Global Business Mobility: Senior or Specialist Worker',
    ratings: ['Worker (A rating)'],
  },
];

describe('hasCredential — one credential per licence', () => {
  test('binds each route to the rating held on THAT route', () => {
    const org = organization(
      buildCompanyJsonLd({ ...base, licences: MIXED }),
    ) as {
      hasCredential: {
        name: string;
        credentialCategory: string;
        recognizedBy: { name: string };
      }[];
    };
    expect(org.hasCredential).toHaveLength(2);
    expect(org.hasCredential[0]).toMatchObject({
      name: 'Skilled Worker sponsor licence',
      credentialCategory: 'Worker (B rating)',
    });
    expect(org.hasCredential[1]).toMatchObject({
      name: 'Global Business Mobility: Senior or Specialist Worker sponsor licence',
      credentialCategory: 'Worker (A rating)',
    });
    expect(org.hasCredential[0].recognizedBy.name).toBe('UK Home Office');
  });

  test('omits the property entirely when there are no licences', () => {
    const org = organization(buildCompanyJsonLd({ ...base, licences: [] }));
    expect(org.hasCredential).toBeUndefined();
  });
});

describe('FAQ answers state the pairing when ratings differ', () => {
  test('rating answer names which route each rating belongs to', () => {
    const answers = faqAnswers(
      buildCompanyJsonLd({ ...base, licences: MIXED }),
    );
    const rating = answers["What is Acme Ltd's sponsor licence rating?"];
    // Title-cased: prose everywhere uses ratingLabel, so the page copy and the
    // structured data cannot disagree on casing.
    expect(rating).toContain('Worker (B Rating) for Skilled Worker');
    expect(rating).toContain(
      'Worker (A Rating) for Global Business Mobility: Senior or Specialist Worker',
    );
  });

  test('a Worker vs Temporary Worker split shows in the ROUTES answer, not as a rating difference', () => {
    // Both licences are A-rated, so claiming the rating "differs by route"
    // would be false — it was, on ~3,289 pages. The licence-TYPE distinction
    // is real though, so it belongs in the routes answer.
    const answers = faqAnswers(
      buildCompanyJsonLd({
        ...base,
        licences: [
          { route: 'Skilled Worker', ratings: ['Worker (A rating)'] },
          {
            route: 'Creative Worker',
            ratings: ['Temporary Worker (A rating)'],
          },
        ],
      }),
    );
    expect(answers["What is Acme Ltd's sponsor licence rating?"]).toBe(
      'Acme Ltd holds A-rated sponsor status on the UK Home Office register.',
    );
    const routes = answers['Which visa routes can Acme Ltd sponsor?'];
    expect(routes).toContain('Worker (A Rating) for Skilled Worker');
    expect(routes).toContain('Temporary Worker (A Rating) for Creative Worker');
  });

  test('keeps the short phrasing when every route shares one rating', () => {
    const answers = faqAnswers(
      buildCompanyJsonLd({
        ...base,
        licences: [
          { route: 'Skilled Worker', ratings: ['Worker (A rating)'] },
          {
            route: 'International Agreement',
            ratings: ['Worker (A rating)'],
          },
        ],
      }),
    );
    const rating = answers["What is Acme Ltd's sponsor licence rating?"];
    expect(rating).toBe(
      'Acme Ltd holds A-rated sponsor status on the UK Home Office register.',
    );
  });

  test('uses plural licence wording for multi-route companies', () => {
    const answers = faqAnswers(
      buildCompanyJsonLd({
        ...base,
        licences: [
          { route: 'Skilled Worker', ratings: ['Worker (A rating)'] },
          {
            route: 'International Agreement',
            ratings: ['Worker (A rating)'],
          },
        ],
      }),
    );
    // "holds a X, Y visa sponsor licence" reads as one malformed licence name.
    expect(answers['Which visa routes can Acme Ltd sponsor?']).toContain(
      'sponsor licences for',
    );
  });

  test('single-route companies keep the singular wording', () => {
    const answers = faqAnswers(
      buildCompanyJsonLd({
        ...base,
        licences: [{ route: 'Skilled Worker', ratings: ['Worker (A rating)'] }],
      }),
    );
    expect(answers['Which visa routes can Acme Ltd sponsor?']).toBe(
      'Acme Ltd holds a Skilled Worker visa sponsor licence with the UK Home Office.',
    );
  });
});

describe('sameAs — the confirmed company website', () => {
  test('emits the website as sameAs, leaving url as this page', () => {
    const org = organization(
      buildCompanyJsonLd({
        ...base,
        licences: MIXED,
        websiteUrl: 'https://ljwb.co.uk',
      }),
    );
    expect(org.sameAs).toBe('https://ljwb.co.uk');
    // url must stay the canonical SponsorSearch page: overloading it with the
    // company's own site would tell a crawler this page IS that site.
    expect(org.url).toBe(base.canonicalUrl);
  });

  test('omits sameAs entirely when no website is confirmed', () => {
    const org = organization(buildCompanyJsonLd({ ...base, licences: MIXED }));
    expect(org).not.toHaveProperty('sameAs');
  });

  test('omits sameAs for an explicit null rather than emitting an empty value', () => {
    const org = organization(
      buildCompanyJsonLd({ ...base, licences: MIXED, websiteUrl: null }),
    );
    expect(org).not.toHaveProperty('sameAs');
  });
});
