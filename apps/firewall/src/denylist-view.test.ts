// The dangerous output here is a confident "safe to retire" on a ban that is still working.

import { describe, expect, test } from 'bun:test';

import { lineText } from './line-model';
import { type DenyEntry, denylistLines } from './denylist-view';

const JA4 = 't13d311200_1d947a95fc68_7e1102d2036b';
const entry = (over: Partial<DenyEntry> = {}): DenyEntry => ({
  kind: 'ja4',
  value: JA4,
  staged: false,
  removed: false,
  requests: 176940,
  denied: 5969,
  ...over,
});

const text = (entries: DenyEntry[], cursor = 0) =>
  denylistLines({ windowHours: 144, entries }, cursor).map(lineText).join('\n');

describe('denylistLines', () => {
  test('a working ban shows what it is catching', () => {
    expect(text([entry()])).toContain('176940 req · 5969 denied');
  });

  test('a genuinely quiet ban is flagged as retirable', () => {
    expect(text([entry({ requests: 0, denied: 0 })])).toContain('safe to retire');
  });

  test('UNKNOWN activity never reads as quiet — that would retire a live ban', () => {
    // Regression: zero-filling an unqueryable value said "safe to retire" for AS29066,
    // which was doing 1,206 req at the time.
    const out = text([entry({ kind: 'asn', value: '29066', requests: undefined })]);
    expect(out).not.toContain('safe to retire');
    expect(out).toContain('not measurable');
  });

  test('a failed JA4 lookup says so rather than implying zero', () => {
    const out = text([entry({ requests: undefined })]);
    expect(out).not.toContain('safe to retire');
    expect(out).toContain('draw no conclusion');
  });

  test('pending changes are called out with the apply reminder', () => {
    const out = text([entry({ staged: true })]);
    expect(out).toContain('STAGED');
    expect(out).toContain('1 unapplied change');
    expect(out).toContain('nothing reaches the WAF until then');
  });

  test('an unbanned entry stays visible until applied', () => {
    expect(text([entry({ removed: true })])).toContain('UNBANNED');
  });

  test('an empty denylist says so instead of rendering a blank pane', () => {
    expect(text([])).toContain('nothing is denied');
  });

  test('the cursor marks exactly one row', () => {
    const out = text([entry(), entry({ value: 'x_y_z' })], 1);
    expect(out.split('▶').length - 1).toBe(1);
  });
});
