// Two invariants that are easy to break by accident: this runs inside the stream loop, so a bad
// config value must not throw; and the configured name must never reach a log.

import { describe, expect, test } from 'bun:test';

import { markerHeaders } from './revalidate';

const NAME = 'x-9f2a7c4e1b3d';

describe('markerHeaders', () => {
  test('sends the header with an inert value', () => {
    expect(markerHeaders(NAME)).toEqual({ [NAME]: '1' });
  });

  test('unset sends nothing, which is a valid state', () => {
    expect(markerHeaders('')).toEqual({});
  });

  test('a malformed name is dropped rather than thrown', () => {
    // fetch rejects an illegal field name, and this call sits inside the stream loop.
    for (const bad of [
      'has space',
      'has:colon',
      'has\nnewline',
      'quote"d',
      'brack[et]',
    ])
      expect(markerHeaders(bad)).toEqual({});
  });

  test('the configured name is never written to a log', () => {
    // The failure path is the tempting place to print what went wrong.
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => said.push(a.join(' '));
    try {
      markerHeaders('not a valid name');
    } finally {
      console.warn = warn;
    }
    expect(said.join(' ')).not.toContain('not a valid name');
    expect(said.join(' ')).toContain('invalid');
  });

  test('a valid name is sent verbatim', () => {
    // Mangling it here would mean the configured name and the sent name differ.
    const mixed = 'X-9F2a7C4e1B3d';
    expect(Object.keys(markerHeaders(mixed))).toEqual([mixed]);
  });

  test('the full token character set is accepted', () => {
    // Asserted on the key list rather than toHaveProperty, which reads a dot in the name as a
    // path separator and goes looking for a nested object.
    const punctuated = "x-a.b_c~d'e";
    expect(Object.keys(markerHeaders(punctuated))).toEqual([punctuated]);
  });
});
