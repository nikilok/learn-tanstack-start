import { describe, expect, test } from 'bun:test';

import {
  type CHCandidate,
  matchesHmrcLocality,
  matchTierA,
  matchTierASquash,
  matchTierD,
  normaliseForComparison,
  normaliseSearchQuery,
  parseHmrcName,
  TIER_A2_SCORE,
} from './pipeline';

/** All example names below are real HMRC register / CH entries from the
 *  2026-07 no_match diagnostic (docs/hmrc-ch-mapping-fix.md). */

const cand = (name: string, over: Partial<CHCandidate> = {}): CHCandidate => ({
  company_number: '12345678',
  company_name: name,
  company_status: 'active',
  previous_company_names: null,
  locality: null,
  region: null,
  ...over,
});

describe('parseHmrcName — existing forms still parse', () => {
  test('T/A splits legal and trading', () => {
    const p = parseHmrcName('AL AMANA LTD T/A GREEN LEAF');
    expect(p.parsedLegal).toBe('AL AMANA LTD');
    expect(p.parsedTrading).toBe('GREEN LEAF');
  });

  test('Trading name of is inverted', () => {
    const p = parseHmrcName('Green Leaf trading name of AL AMANA LTD');
    expect(p.parsedLegal).toBe('AL AMANA LTD');
    expect(p.parsedTrading).toBe('Green Leaf');
  });

  test('branch suffix strips', () => {
    const p = parseHmrcName('ABN AMRO Bank N.V. UK Branch');
    expect(p.parsedLegal).toBe('ABN AMRO Bank N.V.');
  });
});

describe('parseHmrcName — T/A variants', () => {
  test('T/As', () => {
    const p = parseHmrcName('IKM Holdings Ltd. T/As German Doner Kabab');
    expect(p.parsedLegal).toBe('IKM Holdings Ltd.');
    expect(p.parsedTrading).toBe('German Doner Kabab');
  });

  test('T/ As (space after slash)', () => {
    const p = parseHmrcName('Rift Solutions Ltd T/ As Caremark (Leeds)');
    expect(p.parsedLegal).toBe('Rift Solutions Ltd');
    expect(p.parsedTrading).toBe('Caremark (Leeds)');
  });

  test('t/as lowercase', () => {
    const p = parseHmrcName('Hammersmith and Chiswick Landscapes Ltd t/as HCL');
    expect(p.parsedLegal).toBe('Hammersmith and Chiswick Landscapes Ltd');
    expect(p.parsedTrading).toBe('HCL');
  });

  test('bare TA after corporate suffix', () => {
    const p = parseHmrcName('MAHARANIS OF DEEPING LTD TA MAHARANIS');
    expect(p.parsedLegal).toBe('MAHARANIS OF DEEPING LTD');
    expect(p.parsedTrading).toBe('MAHARANIS');
  });

  test('bare TA after LIMITED', () => {
    const p = parseHmrcName('THE NAZ 2020 LIMITED TA The Naz Indian Cuisine');
    expect(p.parsedLegal).toBe('THE NAZ 2020 LIMITED');
    expect(p.parsedTrading).toBe('The Naz Indian Cuisine');
  });

  test('bare TA without a suffix anchor does NOT split', () => {
    // "TA" mid-name with no preceding corporate suffix must stay intact.
    const p = parseHmrcName('Casa Ta Lounge');
    expect(p.parsedLegal).toBe('Casa Ta Lounge');
    expect(p.parsedTrading).toBeNull();
  });

  test('parenthesised (T/A …) tail', () => {
    const p = parseHmrcName(
      'NKD Rathnam Trading Ltd (T/A Chorley Old Road Convenience Store)',
    );
    expect(p.parsedLegal).toBe('NKD Rathnam Trading Ltd');
    expect(p.parsedTrading).toBe('Chorley Old Road Convenience Store');
  });

  test('parenthesised (Trading as …) tail', () => {
    const p = parseHmrcName('Food is Good Limited (Trading as Subway)');
    expect(p.parsedLegal).toBe('Food is Good Limited');
    expect(p.parsedTrading).toBe('Subway');
  });

  test('parenthesised lowercase (t/a …) tail', () => {
    const p = parseHmrcName('TE Digital Limited (t/a ThirdEye Consulting)');
    expect(p.parsedLegal).toBe('TE Digital Limited');
    expect(p.parsedTrading).toBe('ThirdEye Consulting');
  });
});

describe('parseHmrcName — C/O tails and whitespace', () => {
  test('C/O tail is dropped from the legal candidate', () => {
    const p = parseHmrcName(
      'Together at Home Ltd C/O Visiting Angels Home Care',
    );
    expect(p.parsedLegal).toBe('Together at Home Ltd');
    expect(p.parsedTrading).toBeNull();
  });

  test('internal double spaces collapse', () => {
    const p = parseHmrcName('AV RETAILS LTD T/A  PREMIER');
    expect(p.parsedLegal).toBe('AV RETAILS LTD');
    expect(p.parsedTrading).toBe('PREMIER');
  });
});

describe('parseHmrcName — embedded company-number hints', () => {
  test('(Co Reg: NNNNNNNN) extracts and strips', () => {
    const p = parseHmrcName('JIREH HOMECARE LIMITED (Co Reg: 10843126)');
    expect(p.companyNumberHint).toBe('10843126');
    expect(p.parsedLegal).toBe('JIREH HOMECARE LIMITED');
  });

  test('bare trailing 8-digit number extracts and strips', () => {
    const p = parseHmrcName('SS Creative Solutions UK Ltd 15462184');
    expect(p.companyNumberHint).toBe('15462184');
    expect(p.parsedLegal).toBe('SS Creative Solutions UK Ltd');
  });

  test('prefixed numbers (SC/NI) are kept verbatim', () => {
    const p = parseHmrcName('Some Scottish Firm Ltd (Company No. SC614841)');
    expect(p.companyNumberHint).toBe('SC614841');
  });

  test('short numeric parens numbers are zero-padded to 8', () => {
    const p = parseHmrcName('Old Firm Ltd (Co Reg 521245)');
    expect(p.companyNumberHint).toBe('00521245');
  });

  test('short digit runs in names are NOT hints', () => {
    expect(parseHmrcName('MASALA 910 LIMITED').companyNumberHint).toBeNull();
    expect(
      parseHmrcName('THE NAZ 2020 LIMITED TA The Naz Indian Cuisine')
        .companyNumberHint,
    ).toBeNull();
  });
});

describe('normaliseForComparison', () => {
  test('collapses internal whitespace', () => {
    expect(normaliseForComparison('DUMFRIES  FREIGHT LTD')).toBe(
      'DUMFRIES FREIGHT',
    );
  });

  test('folds curly quotes to ASCII apostrophes', () => {
    expect(normaliseForComparison('Brundle’s Transport Ltd')).toBe(
      "BRUNDLE'S TRANSPORT",
    );
  });
});

describe('squashForComparison + matchTierASquash', () => {
  const pairs: [string, string][] = [
    ['Invacare UK Ltd', 'INVACARE (UK) LIMITED'],
    ['JSB Haulage LTD', 'J S B HAULAGE LIMITED'],
    [
      "Miss Millie's Fried Chicken Limited",
      'MISS MILLIES FRIED CHICKEN LIMITED',
    ],
    ['Carel UK Limited', 'CAREL U.K. LTD.'],
    ['Leaf.fm, ltd', 'LEAF.FM LTD'],
    ['Hudl UK Limited', 'HUDL UK, LIMITED'],
    ['Egger UK Limited', 'EGGER (UK) LIMITED'],
    ['Apps IT Limited', 'APPS I.T. LIMITED'],
    ['dailycare4u (Telford) Ltd', 'DAILY CARE 4 U (TELFORD) LTD'],
    ['Takeuchi Mfg UK Ltd', 'TAKEUCHI MFG. (U.K.) LIMITED'],
    ['Brundle’s Ltd', 'BRUNDLES LTD'],
    ['OS Comms Limited', 'O.S. COMMS LIMITED'],
  ];

  for (const [hmrc, ch] of pairs) {
    test(`"${hmrc}" ≡ "${ch}"`, () => {
      expect(matchTierASquash(hmrc, cand(ch))).toBe(TIER_A2_SCORE);
    });
  }

  test('different companies do not squash-match', () => {
    expect(
      matchTierASquash('Carel UK Limited', cand('CARELIDE UK LIMITED')),
    ).toBeNull();
    expect(
      matchTierASquash(
        'Invacare UK Ltd',
        cand('INVACARE UK OPERATIONS LIMITED'),
      ),
    ).toBeNull();
  });

  test('degenerate squashes (below minimum length) never match', () => {
    // Both sides squash to short/empty keys — must not claim equality.
    expect(matchTierASquash('& Ltd', cand('- LIMITED'))).toBeNull();
  });

  test('squash does not fire where Tier A already matches byte-equal names', () => {
    const c = cand('DUMFRIES FREIGHT LIMITED');
    expect(matchTierA('DUMFRIES FREIGHT LTD', c)).toBe(1.0);
  });
});

describe('matchTierD — squashed edit distance', () => {
  test('single transposition: LLYODS → LLOYDS', () => {
    expect(
      matchTierD('JS Llyods Pharma Ltd', cand('JS LLOYDS PHARMA LTD')),
    ).toBe(0.9);
  });

  test('single omission: MADANI → MADNI', () => {
    expect(
      matchTierD('Madani Food Products Ltd', cand('MADNI FOOD PRODUCTS LTD')),
    ).toBe(0.9);
  });

  test('typo suffix: LIMTIED → LIMITED (suffix not stripped, distance-matched)', () => {
    expect(matchTierD('Masala 910 Limtied', cand('MASALA 910 LIMITED'))).toBe(
      0.9,
    );
  });

  test('two edits allowed only on long names', () => {
    expect(
      matchTierD(
        'INEOS Chemical Grangemouth Ltd',
        cand('INEOS CHEMICALS GRANGEMOUTH LIMITED'),
      ),
    ).toBe(0.9);
    // Long name (≥16 squashed), two edits → 0.88.
    expect(
      matchTierD(
        'Dans News & Supermarkets Limited',
        cand('DAN NEWS & SUPERMARKET LIMITED'),
      ),
    ).toBe(0.88);
  });

  test('short names never fuzzy-match', () => {
    expect(matchTierD('BOBA TRA LTD', cand('BOBA TEA LTD'))).toBeNull();
  });

  test('distance beyond the cap rejects', () => {
    expect(
      matchTierD('Kabana Takeaway Ltd', cand('CABANA TAKEAWAYS UK LTD')),
    ).toBeNull();
  });

  test('squash-equal pairs are Tier A2 territory, not Tier D', () => {
    expect(
      matchTierD('Invacare UK Ltd', cand('INVACARE (UK) LIMITED')),
    ).toBeNull();
  });
});

describe('matchesHmrcLocality', () => {
  test('locality vs town, case-insensitive', () => {
    expect(
      matchesHmrcLocality(
        cand('X', { locality: 'Immingham' }),
        'IMMINGHAM',
        null,
      ),
    ).toBe(true);
  });

  test('region vs county', () => {
    expect(
      matchesHmrcLocality(cand('X', { region: 'Kent' }), null, 'kent'),
    ).toBe(true);
  });

  test('no candidate geography → false', () => {
    expect(matchesHmrcLocality(cand('X'), 'LONDON', 'LONDON')).toBe(false);
  });

  test('no HMRC geography → false', () => {
    expect(
      matchesHmrcLocality(cand('X', { locality: 'London' }), null, null),
    ).toBe(false);
  });
});

describe('normaliseSearchQuery', () => {
  test('strips punctuation CH search chokes on', () => {
    expect(normaliseSearchQuery('Leaf.fm, ltd')).toBe('Leaf fm ltd');
    expect(normaliseSearchQuery('Landis+Gyr Metering Solutions Limited')).toBe(
      'Landis Gyr Metering Solutions Limited',
    );
  });

  test('folds smart quotes', () => {
    expect(normaliseSearchQuery('Brundle’s Ltd')).toBe("Brundle's Ltd");
  });

  test('drops mojibake bytes to spaces and collapses', () => {
    expect(normaliseSearchQuery('Bobbyâ??s Newsagent Limited')).toBe(
      'Bobbya s Newsagent Limited',
    );
  });

  test('accent-folds to ASCII', () => {
    expect(normaliseSearchQuery('Café Rouge Limited')).toBe(
      'Cafe Rouge Limited',
    );
  });
});
