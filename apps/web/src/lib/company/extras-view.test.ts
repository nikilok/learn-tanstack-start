import { describe, expect, test } from 'bun:test';

import type { ExtrasOutline } from './extras';
import {
  type ExtrasState,
  extrasState,
  licenceNumbersLabel,
  licenceNumbersView,
  websiteView,
} from './extras-view';

const BOTH: ExtrasOutline = { licenceNumberCount: 2, hasWebsite: true };
const NONE: ExtrasOutline = { licenceNumberCount: 0, hasWebsite: false };
const PENDING: ExtrasState = { status: 'pending' };
const UNAVAILABLE: ExtrasState = { status: 'unavailable' };
const loaded = (
  licenceNumbers: string[],
  website: string | null,
): ExtrasState => ({ status: 'ready', extras: { licenceNumbers, website } });

describe('extrasState', () => {
  test('loaded data is ready, whatever else is true', () => {
    const extras = { licenceNumbers: ['TESTLIC01'], website: null };
    expect(extrasState('ready', extras, false)).toEqual({
      status: 'ready',
      extras,
    });
  });

  test('waiting on the device, or on the load, is pending', () => {
    expect(extrasState('waiting', undefined, false)).toEqual(PENDING);
    expect(extrasState('ready', undefined, false)).toEqual(PENDING);
  });

  test('a device that can never be ready, a refusal or a failed load is unavailable', () => {
    expect(extrasState('off', undefined, false)).toEqual(UNAVAILABLE);
    expect(extrasState('ready', null, false)).toEqual(UNAVAILABLE);
    expect(extrasState('ready', undefined, true)).toEqual(UNAVAILABLE);
  });
});

describe('licenceNumbersView', () => {
  test('holds one line per expected number while pending', () => {
    expect(licenceNumbersView(BOTH, PENDING)).toEqual({
      kind: 'pending',
      count: 2,
    });
  });

  test('holds nothing while pending when the page has no numbers', () => {
    expect(licenceNumbersView(NONE, PENDING)).toEqual({ kind: 'hidden' });
  });

  test('shows what loaded, even where the outline expected none', () => {
    expect(licenceNumbersView(NONE, loaded(['TESTLIC01'], null))).toEqual({
      kind: 'shown',
      numbers: ['TESTLIC01'],
    });
  });

  test('hides when the load came back empty or is not coming', () => {
    expect(licenceNumbersView(BOTH, loaded([], null))).toEqual({
      kind: 'hidden',
    });
    expect(licenceNumbersView(BOTH, UNAVAILABLE)).toEqual({ kind: 'hidden' });
  });
});

describe('websiteView', () => {
  test('pending only when the page has a website', () => {
    expect(websiteView(BOTH, PENDING)).toEqual({ kind: 'pending' });
    expect(websiteView(NONE, PENDING)).toEqual({ kind: 'hidden' });
  });

  test('shows the loaded URL, hides a null or an unavailable load', () => {
    expect(websiteView(NONE, loaded([], 'https://acme.example'))).toEqual({
      kind: 'shown',
      url: 'https://acme.example',
    });
    expect(websiteView(BOTH, loaded([], null))).toEqual({ kind: 'hidden' });
    expect(websiteView(BOTH, UNAVAILABLE)).toEqual({ kind: 'hidden' });
  });
});

describe('licenceNumbersLabel', () => {
  test('plural from the outline before the numbers load, and from them after', () => {
    expect(licenceNumbersLabel({ kind: 'pending', count: 1 })).toBe(
      'Sponsor Licence No.',
    );
    expect(licenceNumbersLabel({ kind: 'pending', count: 2 })).toBe(
      'Sponsor Licence Nos.',
    );
    expect(licenceNumbersLabel({ kind: 'shown', numbers: ['TESTLIC01'] })).toBe(
      'Sponsor Licence No.',
    );
    expect(
      licenceNumbersLabel({
        kind: 'shown',
        numbers: ['TESTLIC01', 'TESTLIC02'],
      }),
    ).toBe('Sponsor Licence Nos.');
  });
});
