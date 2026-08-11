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
    expect(parseGeocodeBody([{ lat: true, lon: false }])).toBeNull();
  });

  test('returns null for partial numerics and blank strings', () => {
    expect(parseGeocodeBody([{ lat: '51.5junk', lon: '-0.1' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '', lon: '' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '  ', lon: '0' }])).toBeNull();
  });

  test('returns null outside latitude/longitude limits, keeps the boundaries', () => {
    expect(parseGeocodeBody([{ lat: '91', lon: '0' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '-90.5', lon: '0' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '0', lon: '181' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '0', lon: '-180.5' }])).toBeNull();
    expect(parseGeocodeBody([{ lat: '90', lon: '-180' }])).toEqual({
      lat: 90,
      lon: -180,
    });
  });
});
