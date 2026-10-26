import { describe, expect, test } from 'bun:test';

import { exactLegalPattern, pageHasExactLegalName } from './exact-legal-name';

describe('pageHasExactLegalName', () => {
  test('finds the registered name closed by its legal form, either spelling', () => {
    const name = 'QUILLMERE ANALYTICS LIMITED';
    expect(pageHasExactLegalName('© 2026 Quillmere Analytics Ltd.', name)).toBe(
      true,
    );
    expect(
      pageHasExactLegalName('Quillmere Analytics Limited, Harrogate', name),
    ).toBe(true);
    expect(pageHasExactLegalName('Quillmere Analytics', name)).toBe(false);
  });

  test('keeps every word, UK included', () => {
    const name = 'VARROWBY (UK) LIMITED';
    expect(pageHasExactLegalName('Varrowby UK Ltd', name)).toBe(true);
    expect(pageHasExactLegalName('Varrowby Ltd', name)).toBe(false);
  });

  test('reads & and AND as one word, and a line break as a space', () => {
    const name = 'HESTWICK & PELLACOMBE LLP';
    expect(pageHasExactLegalName('Hestwick and Pellacombe LLP', name)).toBe(
      true,
    );
    expect(
      pageHasExactLegalName(
        'Hestwick &\n  Pellacombe Limited Liability Partnership',
        name,
      ),
    ).toBe(true);
  });

  test('never inside a URL, handle or domain', () => {
    const name = 'QUILLMERE ANALYTICS LIMITED';
    expect(
      pageHasExactLegalName('Follow @QuillmereAnalytics-Ltd on X', name),
    ).toBe(false);
    expect(
      pageHasExactLegalName(
        'Visit linkedin.com/company/quillmere analytics ltd',
        name,
      ),
    ).toBe(false);
  });

  test('the name as the tail of a longer registered name still matches: only the place half refuses it', () => {
    // A v1 wrong pick: another firm's site printing its own longer name.
    expect(
      pageHasExactLegalName(
        'Northgate Quillmere Analytics Ltd, Toronto',
        'QUILLMERE ANALYTICS LIMITED',
      ),
    ).toBe(true);
  });

  test('a name with a different legal form is not the name', () => {
    expect(
      pageHasExactLegalName(
        'Quillmere Analytics PLC',
        'QUILLMERE ANALYTICS LIMITED',
      ),
    ).toBe(false);
  });
});

describe('exactLegalPattern', () => {
  test('no legal form, or nothing before it, has no pattern', () => {
    expect(exactLegalPattern('QUILLMERE ANALYTICS')).toBeNull();
    expect(exactLegalPattern('LIMITED')).toBeNull();
    expect(exactLegalPattern('QUILLMERE ANALYTICS INC')).toBeNull();
  });

  test('a leading or bracketed THE is optional on the page', () => {
    expect(
      pageHasExactLegalName(
        'The Quillmere Trust Limited',
        'QUILLMERE TRUST LIMITED (THE)',
      ),
    ).toBe(true);
    expect(
      pageHasExactLegalName(
        'Quillmere Trust Ltd',
        'THE QUILLMERE TRUST LIMITED',
      ),
    ).toBe(true);
  });

  test('a community interest company may write its form in full', () => {
    expect(
      pageHasExactLegalName(
        'Pellacombe Arts Community Interest Company',
        'PELLACOMBE ARTS CIC',
      ),
    ).toBe(true);
  });
});
