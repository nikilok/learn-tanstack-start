import { describe, expect, test } from 'bun:test';

import { isStagingCopyOf } from './staging-copy';

describe('isStagingCopyOf', () => {
  const MAIN = 'https://www.quillmere.co.uk';

  test("a site's host under a staging label is a copy of it, with or without www on either", () => {
    for (const copy of [
      'https://www.staging.quillmere.co.uk',
      'https://staging.quillmere.co.uk',
      'https://staging.www.quillmere.co.uk',
    ]) {
      expect(isStagingCopyOf(copy, MAIN)).toBe(true);
      expect(isStagingCopyOf(copy, 'https://quillmere.co.uk')).toBe(true);
    }
  });

  test('preview, dev and test labels mark a copy as staging does', () => {
    for (const label of [
      'dev',
      'preview',
      'stage',
      'staging',
      'stg',
      'test',
      'uat',
    ]) {
      expect(isStagingCopyOf(`https://${label}.quillmere.co.uk`, MAIN)).toBe(
        true,
      );
    }
  });

  test('any other subdomain is a site of its own', () => {
    for (const other of [
      'https://shop.quillmere.co.uk',
      'https://careers.quillmere.co.uk',
      // A label that only starts or ends like one.
      'https://developers.quillmere.co.uk',
      'https://staging-quillmere.co.uk',
    ]) {
      expect(isStagingCopyOf(other, MAIN)).toBe(false);
    }
  });

  test('a copy of another site is not a copy of this one', () => {
    expect(isStagingCopyOf('https://staging.hestwick.co.uk', MAIN)).toBe(false);
    // The same name under another suffix is another domain.
    expect(isStagingCopyOf('https://staging.quillmere.com', MAIN)).toBe(false);
  });

  test('the site is not a copy of itself, nor of its own copy', () => {
    expect(isStagingCopyOf(MAIN, MAIN)).toBe(false);
    expect(isStagingCopyOf(MAIN, 'https://staging.quillmere.co.uk')).toBe(
      false,
    );
  });

  test('a path names one business of many: only the same address, or a page under it, is its copy', () => {
    const franchise = 'https://www.quillmere.co.uk/arun';
    expect(
      isStagingCopyOf('https://staging.quillmere.co.uk/arun', franchise),
    ).toBe(true);
    expect(
      isStagingCopyOf(
        'https://staging.quillmere.co.uk/arun/contact',
        franchise,
      ),
    ).toBe(true);
    expect(
      isStagingCopyOf('https://staging.quillmere.co.uk/barnet', franchise),
    ).toBe(false);
    expect(
      isStagingCopyOf('https://staging.quillmere.co.uk/arundel', franchise),
    ).toBe(false);
    expect(isStagingCopyOf('https://staging.quillmere.co.uk', franchise)).toBe(
      false,
    );
    // Any page of the copy is under a site stored without a path.
    expect(
      isStagingCopyOf('https://staging.quillmere.co.uk/welcome', MAIN),
    ).toBe(true);
  });

  test('a port is part of the address', () => {
    expect(isStagingCopyOf('https://staging.quillmere.co.uk:8443', MAIN)).toBe(
      false,
    );
  });

  test('the scheme is not, as the sweep may store the http form', () => {
    expect(
      isStagingCopyOf(
        'https://staging.quillmere.co.uk',
        'http://www.quillmere.co.uk',
      ),
    ).toBe(true);
  });

  test('nothing is a copy of a row with no address, or of an address that will not parse', () => {
    expect(isStagingCopyOf('https://staging.quillmere.co.uk', null)).toBe(
      false,
    );
    expect(isStagingCopyOf(null, MAIN)).toBe(false);
    expect(isStagingCopyOf('staging.quillmere.co.uk', MAIN)).toBe(false);
    expect(
      isStagingCopyOf('https://staging.quillmere.co.uk', 'not a url'),
    ).toBe(false);
  });
});
