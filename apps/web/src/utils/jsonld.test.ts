import { describe, expect, test } from 'bun:test';

import { buildCompanyJsonLd, ratingPhrase } from './jsonld.ts';

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

describe('ratingPhrase', () => {
  test('maps each registry tier to prose', () => {
    expect(ratingPhrase('Worker (A rating)')).toBe('A-rated');
    expect(ratingPhrase('Temporary Worker (B rating)')).toBe('B-rated');
    expect(ratingPhrase('Worker (A (Premium))')).toBe('A-rated (Premium)');
    expect(ratingPhrase('Worker (A (SME+))')).toBe('A-rated (SME+)');
  });

  test('never leaks the raw feed string for a known tier', () => {
    // This value carries a trailing space that is real in the feed.
    const provisional = ratingPhrase(
      'Worker (UK Expansion Worker: Provisional )',
    );
    expect(provisional).toBe('provisionally rated');
    expect(provisional).not.toContain('(');
  });

  test('dedupes tiers that phrase identically', () => {
    expect(
      ratingPhrase(['Worker (A rating)', 'Temporary Worker (A rating)']),
    ).toBe('A-rated');
  });

  test('joins several distinct tiers grammatically, without a double "and"', () => {
    const phrase = ratingPhrase([
      'Worker (A rating)',
      'Worker (B rating)',
      'Worker (A (Premium))',
    ]);
    expect(phrase).toBe('A-rated, B-rated and A-rated (Premium)');
    expect(phrase).not.toContain('and and');
  });

  test('falls back to the trimmed input for an unrecognised form', () => {
    expect(ratingPhrase('Worker (Z rating) ')).toBe('Worker (Z rating)');
  });
});
