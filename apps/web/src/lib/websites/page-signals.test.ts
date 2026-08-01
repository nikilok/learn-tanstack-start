import { describe, expect, test } from 'bun:test';

import {
  distinctiveTokens,
  isAggregatorHost,
  looksParked,
  nameCorroboration,
  squashName,
} from './page-signals';

describe('distinctiveTokens', () => {
  test('keeps the words that identify a company', () => {
    expect(distinctiveTokens('MOSAIC 1898 LTD')).toEqual(['mosaic', '1898']);
  });

  test('drops the words every third care provider shares', () => {
    // Left in, "care" alone would match any two unrelated providers.
    expect(distinctiveTokens('BARKER CARE LIMITED')).toEqual(['barker']);
    expect(distinctiveTokens('THE CARE HOME GROUP LIMITED')).toEqual([]);
  });

  test('returns nothing for a name made entirely of generic words', () => {
    // Correct, not a bug — and the reason the squashed fallback exists.
    expect(distinctiveTokens('HOME GROUP LIMITED')).toEqual([]);
    expect(distinctiveTokens('HEALTHCARE HOMES (LSC) LIMITED')).toEqual([
      'lsc',
    ]);
  });
});

describe('nameCorroboration — the rule the sample measured', () => {
  test('confirms a site naming the company in both host and page', () => {
    // Mosaic 1898 Ltd -> mosaic1898.co.uk, "Mosaic 1898 | A Disability Charity".
    const result = nameCorroboration(
      'MOSAIC 1898 LTD',
      'www.mosaic1898.co.uk',
      'Mosaic 1898 I A Disability Charity | United Kingdom',
    );
    expect(result.corroborated).toBe(true);
    expect(result.inHost).toContain('mosaic');
    expect(result.inText).toContain('mosaic');
  });

  test('REFUSES a lapsed domain that kept the name but changed hands', () => {
    // The real one: Little Brocklesby House Limited's own domain now serves an
    // online casino. It answers 200, so liveness cannot catch it, and the host
    // still carries the name — only the text betrays it.
    const result = nameCorroboration(
      'LITTLE BROCKLESBY HOUSE LIMITED',
      'www.littlebrocklesbycarehome.co.uk',
      'Ice Fishing Game - Play and Win Big with Ice Fishing in UK. app bonuses demo get bonus live weekly cashback for casino games',
    );
    expect(result.inHost).toContain('brocklesby');
    expect(result.inText).toEqual([]);
    expect(result.corroborated).toBe(false);
  });

  test('refuses an unrelated site that happens to be live', () => {
    // Barker Care Limited -> cedarcarehomes.com. Might be a trading name, but
    // nothing on the page says so, and this rule publishes only what it can see.
    expect(
      nameCorroboration(
        'BARKER CARE LIMITED',
        'cedarcarehomes.com',
        'Cedar Care Homes I Compassionate Residential & Nursing Care in Bristol',
      ).corroborated,
    ).toBe(false);
  });

  test('refuses a group page that names the company but is not its site', () => {
    // Text alone must not be enough: a group or directory page names many
    // companies it does not belong to.
    expect(
      nameCorroboration(
        'ELMCROFT CARE HOME LIMITED',
        'www.abbeyhealthcare.org.uk',
        'Abbey Healthcare. Our homes include Elmcroft and others.',
      ).corroborated,
    ).toBe(false);
  });

  test('confirms a generic name via the squashed fallback', () => {
    // Home Group Limited -> homegroup.org.uk. Every word is a stopword, so the
    // token rule cannot express this and would drop a plainly correct row.
    const result = nameCorroboration(
      'HOME GROUP LIMITED',
      'www.homegroup.org.uk',
      'Home Group | Welcome to Home Group',
    );
    expect(result.squashed).toBe(true);
    expect(result.corroborated).toBe(true);
  });

  test('the squashed fallback still requires the page to say so', () => {
    // Host alone must never be enough, on either path.
    expect(
      nameCorroboration(
        'HOME GROUP LIMITED',
        'www.homegroup.org.uk',
        'Buy cheap watches online now',
      ).corroborated,
    ).toBe(false);
  });

  test('the squashed fallback cannot match a directory on a generic word', () => {
    // "CARE LIMITED" squashes to "care", under the length floor, so it cannot
    // match carehome.co.uk. Without that floor this path admits directories.
    expect(
      nameCorroboration('CARE LIMITED', 'carehome.co.uk', 'care homes near you')
        .corroborated,
    ).toBe(false);
  });

  test('tolerates a qualifier the host leaves out', () => {
    expect(
      nameCorroboration(
        'HEALTHCARE HOMES LIMITED',
        'www.healthcarehomes.co.uk',
        'Healthcare Homes | Care Homes, Home & Live-in Care',
      ).corroborated,
    ).toBe(true);
  });
});

describe('squashName', () => {
  test('strips the legal suffix and punctuation', () => {
    expect(squashName('J.E.M. CARE LIMITED')).toBe('jemcare');
    expect(squashName('Livewell Southwest CIC')).toBe('livewellsouthwest');
  });
});

describe('isAggregatorHost', () => {
  test('rejects a directory listing', () => {
    // Beachcroft Homes Limited pointed at a carehome.co.uk listing page.
    expect(isAggregatorHost('www.carehome.co.uk')).toBe(true);
    expect(isAggregatorHost('opencorporates.com')).toBe(true);
  });

  test('does NOT reject an NHS-hosted practice site', () => {
    // GP practices legitimately run on nhs.uk, and listing it wrongly rejected
    // Eightlands Surgery and The Town Surgery, both correct rows.
    expect(isAggregatorHost('www.eightlandssurgery.nhs.uk')).toBe(false);
  });

  test('matches subdomains but not lookalike suffixes', () => {
    expect(isAggregatorHost('uk.linkedin.com')).toBe(true);
    expect(isAggregatorHost('notcarehome.co.uk')).toBe(false);
  });
});

describe('looksParked', () => {
  test('catches a domain-for-sale holding page', () => {
    expect(
      looksParked(
        'Dovendi - Domain for sale. This domain name is managed by Dovendi. I am interested.',
      ),
    ).toBe(true);
  });

  test('catches a placeholder on the company own domain', () => {
    expect(
      looksParked("Coming Soon pinnaclecarehome.com we're under construction."),
    ).toBe(true);
  });

  test('does NOT reject a real site that mentions the phrase in passing', () => {
    // Three live sites were wrongly rejected by phrase-matching alone: a real
    // provider says "coming soon" about a new home. The length gate is the
    // whole separation, so a long page carrying the phrase must survive.
    const realPage = `${'Home About us Our homes Our care Nursing care Dementia care Respite care Careers News Contact us. '.repeat(20)} Our new wing is coming soon.`;
    expect(realPage.length).toBeGreaterThan(1500);
    expect(looksParked(realPage)).toBe(false);
  });

  test('does not fire on a short page with no parking language', () => {
    expect(looksParked('Stoneacre Lodge residential home. 01302 882148.')).toBe(
      false,
    );
  });
});
