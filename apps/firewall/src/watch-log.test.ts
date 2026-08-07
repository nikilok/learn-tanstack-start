// The log is what answers "was it running, and what did it do while I was elsewhere?" — so the
// quiet events matter as much as the loud ones, and a multi-line verdict must not be able to
// masquerade as a run of separate entries.

import { describe, expect, test } from 'bun:test';

import { clockTime, logEntry } from './watch-log';

const AT = new Date('2026-08-06T14:32:10.500Z');
const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const at = (e: Parameters<typeof logEntry>[1]) => logEntry(AT, e);

// The two clocks are deliberately different, and the reason is the reader: the log is read later
// from anywhere, the status line is read now beside a real clock.
describe('clockTime', () => {
  test('renders the local wall clock, not UTC', () => {
    // Constructed from local components, so this holds in any zone the machine is set to — and
    // it is exactly what UTC got wrong: BST is an hour ahead for most of the British year.
    expect(clockTime(new Date(2026, 7, 6, 14, 32))).toBe('14:32');
  });

  test('pads both halves', () => {
    expect(clockTime(new Date(2026, 7, 6, 9, 5))).toBe('09:05');
  });

  test('midnight is 00:00, never 24:00', () => {
    // toLocaleTimeString with hour12:false renders midnight as 24:00 in some locales.
    expect(clockTime(new Date(2026, 7, 6, 0, 0))).toBe('00:00');
  });

  test('the log stays UTC while the clock does not', () => {
    // Locking the contrast: if someone "fixes" the log to local time later, this fails.
    const at = new Date('2026-08-06T13:47:00Z');
    expect(logEntry(at, { kind: 'disarmed' })).toStartWith(
      '2026-08-06T13:47:00Z',
    );
  });
});

describe('logEntry', () => {
  test('every entry is timestamped to the second, in UTC', () => {
    // Millisecond noise makes lines harder to scan and diff; the zone has to be explicit or a
    // log read six hours later is ambiguous about when the loop actually ran.
    expect(at({ kind: 'disarmed' })).toStartWith('2026-08-06T14:32:10Z');
  });

  test('every entry ends with exactly one newline, so appends cannot run together', () => {
    const events: Parameters<typeof logEntry>[1][] = [
      { kind: 'armed', hours: 6, everyMin: 15 },
      { kind: 'disarmed' },
      { kind: 'screen', fingerprints: 6, profiled: 2, bans: 0 },
      { kind: 'invoke', digest: DIG, allowed: 251, total: 304, reasons: ['x'] },
      { kind: 'verdict', digest: DIG, text: 'a\nb', provenance: 'opus' },
      { kind: 'failed', digest: DIG, error: 'boom' },
      { kind: 'error', error: 'boom' },
    ];
    for (const e of events) {
      const s = at(e);
      expect(s.endsWith('\n')).toBe(true);
      expect(s.endsWith('\n\n')).toBe(false);
    }
  });

  test('a quiet screen is still recorded', () => {
    // Without this the log cannot distinguish "ran and found nothing" from "never ran".
    const s = at({ kind: 'screen', fingerprints: 0, profiled: 0, bans: 0 });
    expect(s).toContain('screen');
    expect(s).toContain('0 allowed through');
  });

  test('an invocation is shouted, with the reasons that caused it', () => {
    const s = at({
      kind: 'invoke',
      digest: DIG,
      allowed: 251,
      total: 304,
      reasons: ['offers no ALPN', 'spans 11 IPs'],
    });
    expect(s).toContain('INVOKE');
    expect(s).toContain(DIG);
    expect(s).toContain('251 allowed of 304');
    expect(s).toContain('why: offers no ALPN');
    expect(s).toContain('why: spans 11 IPs');
  });

  test('an invocation with no recorded reasons still logs cleanly', () => {
    const s = at({
      kind: 'invoke',
      digest: DIG,
      allowed: 1,
      total: 1,
      reasons: [],
    });
    expect(s).toContain('INVOKE');
    expect(s.endsWith('\n')).toBe(true);
  });

  test('a verdict is indented so its lines cannot read as separate events', () => {
    const s = at({
      kind: 'verdict',
      digest: DIG,
      text: 'VERDICT: leave\nbecause X',
      provenance: 'claude-opus-5 · $1.2300',
    });
    const [head, ...body] = s.trimEnd().split('\n');
    expect(head).toContain('verdict');
    expect(body.every((l) => l.startsWith('    '))).toBe(true);
  });

  test('a failure is recorded as loudly as a verdict', () => {
    // A run that failed must never be indistinguishable from one that concluded nothing.
    const s = at({ kind: 'failed', digest: DIG, error: 'claude exited 1' });
    expect(s).toContain('FAILED');
    expect(s).toContain('claude exited 1');
  });

  test('a screen that threw is its own event, not a silent gap', () => {
    expect(at({ kind: 'error', error: 'observability 429' })).toContain(
      'ERROR',
    );
  });

  test('arming records the cadence, so the log explains its own spacing', () => {
    const s = at({ kind: 'armed', hours: 6, everyMin: 15 });
    expect(s).toContain('6h window');
    expect(s).toContain('every 15m');
  });
});

// Shadow entries record a decision that was NOT acted on. The wording is the whole risk: read at
// 3am, an ambiguous line is read as an action taken.
describe('shadow entries', () => {
  const at = new Date('2026-08-07T04:00:00.000Z');
  const D = 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb';

  test('a refusal is recorded with its reason', () => {
    const out = logEntry(at, {
      kind: 'shadow',
      digest: D,
      refusal: 'spans 40 IPs — too broad to deny unattended',
    });
    expect(out).toContain('shadow');
    expect(out).toContain('too broad to deny unattended');
    expect(out.endsWith('\n')).toBe(true);
  });

  test('a would-apply says so, and says nothing was applied', () => {
    // `null` means the gate found no reason to refuse. Rendering that as a bare "would apply" —
    // or worse, as an empty reason — is how a shadow entry gets read as a ban that happened.
    const out = logEntry(at, { kind: 'shadow', digest: D, refusal: null });
    expect(out).toContain('WOULD HAVE APPLIED');
    expect(out).toContain('nothing was applied');
  });

  test('it stays one line, so it cannot be read as several events', () => {
    const out = logEntry(at, { kind: 'shadow', digest: D, refusal: null });
    expect(out.trimEnd().split('\n')).toHaveLength(1);
  });
});
