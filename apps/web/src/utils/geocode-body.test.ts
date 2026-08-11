import { describe, expect, test } from 'bun:test';

import { parseGeocodeBody } from './geocode-body';

describe('parseGeocodeBody', () => {
  test('parses Nominatim string coordinates', () => {
    expect(parseGeocodeBody([{ lat: '51.5074', lon: '-0.1278' }])).toEqual({
      lat: 51.5074,
      lon: -0.1278,
    });
  });

  test('parses numeric coordinates', () => {
    expect(parseGeocodeBody([{ lat: 51.5, lon: -0.1 }])).toEqual({
      lat: 51.5,
      lon: -0.1,
    });
  });

  test('returns null for an empty result set', () => {
    expect(parseGeocodeBody([])).toBeNull();
  });

  test('returns null for malformed hits', () => {
    expect(parseGeocodeBody([null])).toBeNull();
    expect(parseGeocodeBody(['51.5,-0.1'])).toBeNull();
    expect(parseGeocodeBody([{}])).toBeNull();
    expect(parseGeocodeBody([{ lat: '51.5' }])).toBeNull();
  });

  test('returns null for unparseable or non-finite coordinates', () => {
    expect(parseGeocodeBody([{ lat: 'abc', lon: '-0.1' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: 'Infinity', lon: '0' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: null, lon: null }])).toBeNull();
  });
});
