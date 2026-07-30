import { describe, expect, test } from 'bun:test';

import { displayDomain } from './website';

describe('displayDomain', () => {
  test('drops the scheme, so the label reads as a destination', () => {
    expect(displayDomain('https://ljwb.co.uk')).toBe('ljwb.co.uk');
  });

  test('drops a leading www.', () => {
    expect(displayDomain('https://www.grosvenorcare.co.uk')).toBe(
      'grosvenorcare.co.uk',
    );
  });

  test('leaves a www lookalike alone', () => {
    // wwww.idealhomecare.uk is a real stored row (a typo in the CQC feed that
    // nonetheless resolves), and rewriting it would link somewhere we never
    // fetched.
    expect(displayDomain('https://wwww.idealhomecare.uk')).toBe(
      'wwww.idealhomecare.uk',
    );
  });

  test('keeps a path, because the stored url can point at a branch page', () => {
    // Elmfield Care's CQC record names one home, not the group homepage.
    expect(displayDomain('https://www.elmfieldcare.co.uk/flowers-manor')).toBe(
      'elmfieldcare.co.uk/flowers-manor',
    );
  });

  test('drops a bare trailing slash but not a real path', () => {
    expect(displayDomain('https://example.co.uk/')).toBe('example.co.uk');
    expect(displayDomain('https://example.co.uk/about/')).toBe(
      'example.co.uk/about/',
    );
  });

  test('keeps the port and query, which change where the link goes', () => {
    expect(displayDomain('https://example.co.uk:8443/arun?x=1')).toBe(
      'example.co.uk:8443/arun?x=1',
    );
  });

  test('falls back to the raw value rather than rendering an empty link', () => {
    expect(displayDomain('not a url')).toBe('not a url');
  });

  test('returns the destination only, never a note about the check', () => {
    // The label is the whole visible section, so anything this function adds
    // becomes page copy. How a url was confirmed is not page copy.
    expect(displayDomain('https://ljwb.co.uk')).toBe('ljwb.co.uk');
  });
});
