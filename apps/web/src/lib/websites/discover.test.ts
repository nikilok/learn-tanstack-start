import { describe, expect, test } from 'bun:test';

import {
  buildQuery,
  type CandidateProbe,
  decideFromCandidates,
  MAX_CANDIDATES,
} from './discover';

const probe = (over: Partial<CandidateProbe> = {}): CandidateProbe => ({
  url: 'https://example.co.uk',
  crnFound: false,
  postcodeFound: false,
  onAggregator: false,
  parked: false,
  ...over,
});

describe('decideFromCandidates', () => {
  test('a registration number wins wherever it appears', () => {
    // The company identifying itself outranks position: a lower-ranked result
    // carrying the number beats a higher-ranked one carrying only an address.
    const outcome = decideFromCandidates([
      probe({ url: 'https://first.co.uk', postcodeFound: true }),
      probe({ url: 'https://second.co.uk', crnFound: true }),
    ]);
    expect(outcome.evidence).toBe('crn_on_page');
    expect(outcome.url).toBe('https://second.co.uk');
    expect(outcome.rank).toBe(2);
  });

  test('otherwise the highest-ranked address match wins', () => {
    const outcome = decideFromCandidates([
      probe({ url: 'https://a.co.uk' }),
      probe({ url: 'https://b.co.uk', postcodeFound: true }),
      probe({ url: 'https://c.co.uk', postcodeFound: true }),
    ]);
    expect(outcome.evidence).toBe('postcode_on_page');
    expect(outcome.url).toBe('https://b.co.uk');
    expect(outcome.rank).toBe(2);
  });

  test('finds nothing rather than guessing at the top result', () => {
    // Roughly a third of real company sites carry neither signal. Those are
    // discarded: publishing the first search hit because it was first is
    // exactly the name-matching this pipeline exists to avoid.
    const outcome = decideFromCandidates([probe(), probe(), probe()]);
    expect(outcome).toEqual({ url: null, evidence: 'none', rank: null });
  });

  test('a directory listing never wins, even carrying the number', () => {
    // Endole, OpenCorporates and the Companies House service all print the
    // registration number on their listing pages, so the strongest signal
    // fires hardest on exactly the pages that are not the company's website.
    const outcome = decideFromCandidates([
      probe({
        url: 'https://www.endole.co.uk/company/03260168',
        crnFound: true,
        onAggregator: true,
      }),
      probe({ url: 'https://real.co.uk', postcodeFound: true }),
    ]);
    expect(outcome.url).toBe('https://real.co.uk');
    expect(outcome.evidence).toBe('postcode_on_page');
  });

  test('a parked page never wins either', () => {
    const outcome = decideFromCandidates([
      probe({ url: 'https://parked.co.uk', postcodeFound: true, parked: true }),
    ]);
    expect(outcome.evidence).toBe('none');
  });

  test('an empty result set is nothing, not a crash', () => {
    expect(decideFromCandidates([])).toEqual({
      url: null,
      evidence: 'none',
      rank: null,
    });
  });
});

describe('MAX_CANDIDATES', () => {
  test('stops where recall stopped improving', () => {
    // Measured: 60.0% at rank 1, 76.0% at 3, 80.7% at 5, and 80.7% at 10.
    // Fetching six through ten costs a second and a half each across 109k
    // companies and finds nothing.
    expect(MAX_CANDIDATES).toBe(5);
  });
});

describe('buildQuery', () => {
  test('drops the legal suffix and appends the town', () => {
    expect(buildQuery('BRENDONCARE FOUNDATION LIMITED', 'Winchester')).toBe(
      'BRENDONCARE FOUNDATION Winchester',
    );
  });

  test('handles a suffix written with full stops', () => {
    expect(buildQuery('ACME CARE C.I.C.', 'Leeds')).toBe('ACME CARE Leeds');
  });

  test('omits the town when we hold none', () => {
    expect(buildQuery('MOSAIC 1898 LTD', '')).toBe('MOSAIC 1898');
    expect(buildQuery('MOSAIC 1898 LTD', '   ')).toBe('MOSAIC 1898');
  });

  test('returns nothing searchable for a name that is only a suffix', () => {
    // Guards the caller: an empty query would burn a credit and return the
    // whole web.
    expect(buildQuery('LIMITED', 'Leeds')).toBe('');
  });
});
