import { describe, expect, test } from 'bun:test';

import { type ListingToStart, startListing } from './listing-prefetch';

/** What `startListing` started for a search, and whether it asked if results render in the document. */
async function started(
  term: string,
  params: Record<string, unknown>,
  renders = true,
) {
  const listings: ListingToStart[] = [];
  let asked = false;
  await startListing({
    term,
    params,
    rendered: async () => {
      asked = true;
      return renders;
    },
    start: (listing) => listings.push(listing),
  });
  return { listings, asked };
}

describe('startListing', () => {
  test('nothing is started, of either kind, where results do not render in the document', async () => {
    expect(await started('acme', {}, false)).toEqual({
      listings: [],
      asked: true,
    });
    expect(await started('acme', { route: 'Skilled Worker' }, false)).toEqual({
      listings: [],
      asked: true,
    });
    expect(await started('', { route: 'Skilled Worker' }, false)).toEqual({
      listings: [],
      asked: true,
    });
  });

  test('a term of 3 or more is a name search', async () => {
    expect((await started('acme', {})).listings).toEqual([
      { kind: 'name', term: 'acme' },
    ]);
  });

  test('any filter makes it the filter listing, the term riding along once it is 3 characters', async () => {
    expect(
      (await started('acme', { route: 'Skilled Worker' })).listings,
    ).toEqual([
      { kind: 'filter', filters: { q: 'acme', route: ['Skilled Worker'] } },
    ]);
    expect((await started('ac', { route: 'Skilled Worker' })).listings).toEqual(
      [{ kind: 'filter', filters: { route: ['Skilled Worker'] } }],
    );
  });

  test('a param that filters nothing leaves a name search a name search', async () => {
    expect(
      (await started('acme', { utm_source: 'newsletter', render: 'client' }))
        .listings,
    ).toEqual([{ kind: 'name', term: 'acme' }]);
  });

  test('with nothing to start, whether results render is not even asked', async () => {
    expect(await started('ac', {})).toEqual({ listings: [], asked: false });
    expect(await started('', { utm_source: 'x' })).toEqual({
      listings: [],
      asked: false,
    });
  });
});
