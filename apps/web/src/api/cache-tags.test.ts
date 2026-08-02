import { describe, expect, test } from 'bun:test';

import {
  ALL_COMPANY_PAGES_TAG,
  companyCacheTagHeader,
  companyTag,
} from './cache-tags';

describe('companyTag', () => {
  test('matches the spelling the ch-stream trail drain purges by', () => {
    expect(companyTag('00002404')).toBe('company-00002404');
  });
});

describe('companyCacheTagHeader', () => {
  test('joins the own tag and the population tag in one header value', () => {
    // One WRITE, not two calls: setResponseHeader overwrites, so tagging via
    // two setCacheTag calls would silently drop whichever tag came first —
    // either breaking per-company purges or the nightly population purge.
    expect(companyCacheTagHeader('00002404')).toBe(
      'company-00002404,company-pages',
    );
  });

  test('comma-separated with no space, per Vercel multi-tag format', () => {
    expect(companyCacheTagHeader('SC499359')).not.toContain(' ');
    expect(companyCacheTagHeader('SC499359').split(',')).toEqual([
      companyTag('SC499359'),
      ALL_COMPANY_PAGES_TAG,
    ]);
  });

  test('the tag spelling is load-bearing outside this package', () => {
    // The sweep workflow curls ?purge=company-pages as a literal string, and
    // the endpoint whitelists it. Renaming the constant must fail HERE, not
    // as a silently no-op cron purging a tag nothing carries.
    expect(ALL_COMPANY_PAGES_TAG).toBe('company-pages');
  });
});
