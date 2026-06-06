import { describe, expect, test } from 'bun:test';

import { companySearchName } from './utils.ts';

describe('companySearchName', () => {
  test('strips trailing legal suffixes', () => {
    expect(companySearchName('Acme Ltd')).toBe('Acme');
    expect(companySearchName('Acme Limited')).toBe('Acme');
    expect(companySearchName('Globex PLC')).toBe('Globex');
    expect(companySearchName('Initech LLP')).toBe('Initech');
    expect(companySearchName('Acme, Inc')).toBe('Acme');
    expect(companySearchName('Acme Holdings Ltd.')).toBe('Acme Holdings');
  });

  test('strips parenthetical qualifiers like (UK)', () => {
    expect(companySearchName('Acme (UK) Ltd')).toBe('Acme');
    expect(companySearchName('Acme (UK) Limited')).toBe('Acme');
    expect(companySearchName('Acme (Holdings) PLC')).toBe('Acme');
  });

  test('strips a dangling "& Co" once the suffix is gone', () => {
    expect(companySearchName('Smith & Co Ltd')).toBe('Smith');
    expect(companySearchName('Smith and Co Limited')).toBe('Smith');
  });

  test('drops a "t/a" trading-as tail', () => {
    expect(companySearchName('Foo Ltd t/a Bar')).toBe('Foo');
    expect(companySearchName('Foo Limited trading as Bar')).toBe('Foo');
  });

  test('keeps meaningful name words (Group, Holdings, leading UK)', () => {
    expect(companySearchName('Acme Group Limited')).toBe('Acme Group');
    expect(companySearchName('UK Power Networks Limited')).toBe(
      'UK Power Networks',
    );
    expect(companySearchName('Marks & Spencer Group Plc')).toBe(
      'Marks & Spencer Group',
    );
  });

  test('collapses whitespace and tidies punctuation', () => {
    expect(companySearchName('  Acme   Ltd  ')).toBe('Acme');
  });

  test('falls back to the original when cleaning would empty it', () => {
    expect(companySearchName('Limited')).toBe('Limited');
    expect(companySearchName('Acme')).toBe('Acme');
  });
});
