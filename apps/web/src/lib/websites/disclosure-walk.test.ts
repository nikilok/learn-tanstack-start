import { describe, expect, test } from 'bun:test';

import {
  legalLinks,
  MAX_LEGAL_LINKS,
  readWalkPage,
  walkTargets,
} from './disclosure-walk';

const page = (links: string) => `<html><body><nav>${links}</nav></body></html>`;

describe('legalLinks', () => {
  test('finds the legal pages a homepage links to, privacy first', () => {
    const html = page(
      '<a href="/terms-of-use">Terms of use</a>' +
        '<a href="/contact">Contact</a>' +
        '<a href="/privacy-notice">Privacy notice</a>' +
        '<a href="/about">About us</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk/')).toEqual([
      'https://acme.co.uk/privacy-notice',
      'https://acme.co.uk/terms-of-use',
    ]);
  });

  test('matches the label as well as the target', () => {
    const html = page(
      '<a href="/ln">Legal <b>notice</b></a><a href="/ci">Company information</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/ln',
      'https://acme.co.uk/ci',
    ]);
  });

  test('stays on the site, www or not', () => {
    const html = page(
      '<a href="https://acme.co.uk/privacy">Privacy</a>' +
        '<a href="https://host.example/privacy">Privacy (our web host)</a>',
    );
    expect(legalLinks(html, 'https://www.acme.co.uk/')).toEqual([
      'https://acme.co.uk/privacy',
    ]);
  });

  test('resolves against the page that was read, after redirects', () => {
    const html = page('<a href="legal">Legal</a>');
    expect(legalLinks(html, 'https://acme.co.uk/en/')).toEqual([
      'https://acme.co.uk/en/legal',
    ]);
  });

  test('skips links that are not pages', () => {
    const html = page(
      '<a href="mailto:privacy@acme.co.uk">Privacy</a>' +
        '<a href="tel:+441234">Terms</a>' +
        '<a href="javascript:void(0)">Cookie settings</a>' +
        '<a href="#legal">Legal</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([]);
  });

  test('reads one page once, dropping the fragment and keeping the query', () => {
    const html = page(
      '<a href="/privacy">Privacy</a><a href="/privacy/">Privacy</a>' +
        '<a href="/privacy#top">Privacy</a>' +
        '<a href="/?page_id=3&amp;lang=en">Terms</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/privacy',
      'https://acme.co.uk/?page_id=3&lang=en',
    ]);
  });

  test('an unparseable page URL yields nothing', () => {
    expect(legalLinks(page('<a href="/privacy">Privacy</a>'), 'nope')).toEqual(
      [],
    );
  });
});

describe('walkTargets', () => {
  const origin = 'https://acme.co.uk';

  test('reads the homepage links first, then the fixed paths', () => {
    // A registration number only behind a /terms-of-use link: no fixed path
    // list guesses that page.
    expect(walkTargets(origin, [`${origin}/terms-of-use`], 7)).toEqual([
      `${origin}/terms-of-use`,
      `${origin}/privacy`,
      `${origin}/privacy-policy`,
      `${origin}/terms-and-conditions`,
      `${origin}/terms`,
      `${origin}/legal`,
      `${origin}/contact-us`,
      `${origin}/contact`,
    ]);
  });

  test('a link to a fixed path is not read twice', () => {
    const targets = walkTargets(origin, ['https://www.acme.co.uk/privacy/'], 7);
    expect(targets.filter((t) => t.endsWith('/privacy'))).toEqual([
      `${origin}/privacy`,
    ]);
  });

  test('a link to an about page stays out, like the fixed about paths', () => {
    expect(walkTargets(origin, [`${origin}/about-us`], 7)).not.toContain(
      `${origin}/about-us`,
    );
  });

  test('caps the homepage links', () => {
    const links = Array.from({ length: 9 }, (_, i) => `${origin}/legal/${i}`);
    expect(walkTargets(origin, links, 0)).toHaveLength(MAX_LEGAL_LINKS);
  });

  test('seven fixed paths stop before the about pages', () => {
    const targets = walkTargets(origin, [], 7);
    expect(targets).toHaveLength(7);
    expect(targets.some((t) => t.includes('/about'))).toBe(false);
  });
});

describe('readWalkPage', () => {
  const row = { companyNumber: '03260168', postcode: 'SO22 5AZ' };
  const footer = '<footer>Acme Ltd. Company No. 03260168, SO22 5AZ</footer>';

  test('reads proof and stated numbers off a page on the site', () => {
    const page = readWalkPage(
      row,
      'https://acme.co.uk/privacy',
      footer,
      new Set(),
    );
    expect(page).toMatchObject({ crnFound: true, postcodeFound: true });
    expect(page?.stated.map((s) => s.companyNumber)).toEqual(['03260168']);
  });

  test('a disclosure path that redirects into a register proves nothing', () => {
    // /company-information -> the Companies House profile prints the number.
    expect(
      readWalkPage(
        row,
        'https://find-and-update.company-information.service.gov.uk/company/03260168',
        footer,
        new Set(),
      ),
    ).toBeNull();
  });

  test('nor does one that lands on a crowded directory', () => {
    expect(
      readWalkPage(
        row,
        'https://sponsor-list.example/company/acme',
        footer,
        new Set(['sponsor-list.example']),
      ),
    ).toBeNull();
  });
});
