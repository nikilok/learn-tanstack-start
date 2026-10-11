import { describe, expect, test } from 'bun:test';

import { RENDER_PARAM } from '../session/calls';
import { companySearch, isShell, shellName, shownWithoutData } from './shell';

describe('companySearch', () => {
  test("keeps the edge's shell mark, or the router would redirect the shell's URL", () => {
    expect(companySearch({ [RENDER_PARAM]: 'client' })).toEqual({
      search: '',
      render: 'client',
    });
  });

  test('a page without the mark carries no render key at all, so no URL gains one', () => {
    for (const search of [
      {},
      { render: 'server' },
      { render: '' },
      { render: 1 },
    ])
      expect(Object.keys(companySearch(search))).toEqual(['search']);
  });

  test('the search term is read as before: a numeric term stays text', () => {
    expect(companySearch({ search: 365 }).search).toBe('365');
    expect(companySearch({ search: 'acme', render: 'client' })).toEqual({
      search: 'acme',
      render: 'client',
    });
  });

  test('the key it keeps is the parameter the edge adds', () => {
    expect(RENDER_PARAM).toBe('render');
  });
});

describe('isShell', () => {
  test('only the mark makes a page the shell', () => {
    expect(isShell({ render: 'client' })).toBe(true);
    expect(isShell({ search: 'acme' })).toBe(false);
    expect(isShell(undefined)).toBe(false);
  });
});

describe('shownWithoutData', () => {
  const shell = { search: '', render: 'client' as const };
  const plain = { search: '' };

  test('the shell on the server, which sees the mark', () => {
    expect(shownWithoutData({ search: shell, status: 'success' })).toBe(true);
  });

  test('the shell in the browser, whose address has no mark: a page still loading, or failed', () => {
    expect(shownWithoutData({ search: plain, status: 'pending' })).toBe(true);
    expect(shownWithoutData({ search: plain, status: 'error' })).toBe(true);
  });

  test('a page with its data, or one for no company, is not', () => {
    expect(
      shownWithoutData({ loaderData: {}, search: plain, status: 'pending' }),
    ).toBe(false);
    expect(
      shownWithoutData({ loaderData: {}, search: shell, status: 'success' }),
    ).toBe(false);
    expect(shownWithoutData({ search: plain, status: 'notFound' })).toBe(false);
    expect(shownWithoutData({ search: plain, status: 'success' })).toBe(false);
  });
});

describe('shellName', () => {
  test('spells the company from its slug', () => {
    expect(shellName('analog-and-digital-solutions-limited')).toBe(
      'Analog And Digital Solutions Limited',
    );
  });
});
