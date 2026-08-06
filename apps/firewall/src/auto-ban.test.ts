// This is the only code in the tool that can deny live traffic without a human, so every test
// here is about the same question: what stops it? The gate, the clock, and the fact that both
// fail closed.

import { describe, expect, test } from 'bun:test';

import {
  AUTO_BAN_FLAG,
  type BanCandidate,
  addStrike,
  autoBanEnabled,
  autoBanRefusal,
  banDuration,
  dueForRevocation,
  expiryRecord,
  parseExpiries,
  parseStrikes,
  serialiseExpiries,
  serialiseStrikes,
  strikesFor,
} from './auto-ban';

const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const candidate = (over: Partial<BanCandidate> = {}): BanCandidate => ({
  digest: DIG,
  verdict: 'ban',
  blockers: [],
  renderingRequests: 0,
  ips: 3,
  total: 9060,
  windowTotal: 5_000_000,
  ...over,
});

describe('autoBanEnabled', () => {
  test('off unless explicitly set to 1', () => {
    // Default-off is the whole point: the screen has never produced a live ban verdict, so
    // enabling this before it has would be enabling it on expectation rather than evidence.
    expect(autoBanEnabled({})).toBe(false);
    expect(autoBanEnabled({ [AUTO_BAN_FLAG]: '' })).toBe(false);
    expect(autoBanEnabled({ [AUTO_BAN_FLAG]: '0' })).toBe(false);
    expect(autoBanEnabled({ [AUTO_BAN_FLAG]: 'true' })).toBe(false);
    expect(autoBanEnabled({ [AUTO_BAN_FLAG]: 'yes' })).toBe(false);
  });

  test('on for exactly 1', () => {
    expect(autoBanEnabled({ [AUTO_BAN_FLAG]: '1' })).toBe(true);
  });
});

describe('autoBanRefusal', () => {
  test('a clean ban candidate passes', () => {
    expect(autoBanRefusal(candidate())).toBeNull();
  });

  test('anything but a ban verdict is refused', () => {
    for (const v of ['watch', 'leave', 'already', 'staged'])
      expect(autoBanRefusal(candidate({ verdict: v }))).toContain(v);
  });

  test('an advisory blocker refuses it, and the reason is carried', () => {
    // The blockers exist because of real near-misses. Auto-apply must never outrank them.
    const r = autoBanRefusal(
      candidate({ blockers: ['281 rendering requests (92.4%)'] }),
    );
    expect(r).toContain('advisory blocked it');
    expect(r).toContain('92.4%');
  });

  test('ANY rendering at all refuses it', () => {
    // The case this exists for: several tells agreeing while the traffic was overwhelmingly
    // map tiles, RPCs and analytics beacons — a real session, not a harvester. One rendering
    // request means a browser has run the app from that fingerprint, which is not something to
    // deny while nobody is watching.
    expect(autoBanRefusal(candidate({ renderingRequests: 1 }))).toContain(
      'rendering request',
    );
    expect(autoBanRefusal(candidate({ renderingRequests: 0 }))).toBeNull();
  });

  test('too many IPs refuses it', () => {
    // A fingerprint spread wide is more likely a popular client build than one actor.
    expect(autoBanRefusal(candidate({ ips: 26 }))).toContain('spans 26 IPs');
    expect(autoBanRefusal(candidate({ ips: 25 }))).toBeNull();
  });

  test('too large a share of traffic refuses it', () => {
    expect(
      autoBanRefusal(candidate({ total: 200_000, windowTotal: 1_000_000 })),
    ).toContain('% of window traffic');
  });

  test('a zero-traffic window cannot divide by zero into a pass', () => {
    expect(autoBanRefusal(candidate({ total: 10, windowTotal: 0 }))).toBeNull();
  });

  test('the refusal names one reason, so a log line says which gate stopped it', () => {
    const r = autoBanRefusal(candidate({ verdict: 'leave', ips: 900 }));
    expect(r).toContain('leave');
  });
});

describe('expiry records', () => {
  test('round-trips', () => {
    const until = new Date('2026-08-06T20:00:00.000Z');
    const raw = expiryRecord(DIG, until);
    expect(parseExpiries(raw)).toEqual([
      { digest: DIG, until: until.getTime() },
    ]);
  });

  test('reads several, and normalises case', () => {
    const raw = `${DIG.toUpperCase()}|2026-08-06T20:00:00.000Z, other|2026-08-06T21:00:00.000Z`;
    expect(parseExpiries(raw).map((e) => e.digest)).toEqual([DIG, 'other']);
  });

  test('the separator cannot occur in a digest or a timestamp', () => {
    // A JA4 is hex, letters and underscores; an ISO stamp has no pipe. So no record can be split
    // wrongly by its own content, which is what the previous @-separated format risked.
    expect(parseExpiries('a@b|2026-08-06T20:00:00.000Z')[0]?.digest).toBe(
      'a@b',
    );
  });

  test('drops what it cannot read rather than inventing an expiry', () => {
    // A guessed expiry is worse than a forgotten one: forgetting leaves the digest in the
    // denylist for a human to find, guessing silently un-bans at the wrong time.
    expect(parseExpiries('nonsense')).toEqual([]);
    expect(parseExpiries('digest|not-a-date')).toEqual([]);
    expect(parseExpiries('|2026-08-06T20:00:00.000Z')).toEqual([]);
    expect(parseExpiries(undefined)).toEqual([]);
    expect(parseExpiries('')).toEqual([]);
  });

  test('one bad record does not discard the good ones alongside it', () => {
    const raw = `junk, ${DIG}|2026-08-06T20:00:00.000Z`;
    expect(parseExpiries(raw)).toHaveLength(1);
  });

  test('serialise produces what parse accepts', () => {
    const e = [{ digest: DIG, until: Date.parse('2026-08-06T20:00:00.000Z') }];
    expect(parseExpiries(serialiseExpiries(e))).toEqual(e);
  });

  test('serialising nothing is an empty string, not "undefined"', () => {
    expect(serialiseExpiries([])).toBe('');
  });
});

// Coming back is itself evidence: a one-off might have been a wrong call, a returner was not.
describe('banDuration', () => {
  const H = 60 * 60_000;

  test('doubles per prior strike', () => {
    expect(banDuration(0)).toBe(6 * H);
    expect(banDuration(1)).toBe(12 * H);
    expect(banDuration(2)).toBe(24 * H);
    expect(banDuration(3)).toBe(48 * H);
  });

  test('caps at a week', () => {
    // Past a week the TTL has stopped being a safety net. A mistake is supposed to heal itself
    // while nobody is watching, and a ban measured in months does not.
    expect(banDuration(10)).toBe(7 * 24 * H);
    expect(banDuration(100)).toBe(7 * 24 * H);
  });

  test('an absurd strike count cannot produce an unbounded ban', () => {
    // 2 ** 1024 is Infinity, and Infinity survives Math.min — a ban with no expiry at all.
    expect(Number.isFinite(banDuration(5000))).toBe(true);
    expect(banDuration(5000)).toBe(7 * 24 * H);
  });

  test('negative or fractional counts fall back to the base', () => {
    expect(banDuration(-3)).toBe(6 * H);
    expect(banDuration(0.9)).toBe(6 * H);
  });
});

describe('strikes', () => {
  const NOW = Date.parse('2026-08-06T20:00:00.000Z');
  const DAY = 24 * 60 * 60_000;

  test('an identity never banned has no strikes', () => {
    expect(strikesFor([], DIG, NOW)).toBe(0);
  });

  test('counts prior offences, case-insensitively', () => {
    const s = [{ digest: DIG, count: 2, at: NOW - DAY }];
    expect(strikesFor(s, DIG.toUpperCase(), NOW)).toBe(2);
  });

  test('a strike older than the decay window does not count', () => {
    // Otherwise a fingerprint banned a year ago escalates a different actor who happens to share
    // that client build.
    const s = [{ digest: DIG, count: 3, at: NOW - 31 * DAY }];
    expect(strikesFor(s, DIG, NOW)).toBe(0);
  });

  test('adding a strike increments, and stamps the time', () => {
    const s = addStrike([{ digest: DIG, count: 1, at: NOW - DAY }], DIG, NOW);
    expect(s).toEqual([{ digest: DIG, count: 2, at: NOW }]);
  });

  test('adding prunes decayed records, so the list cannot grow forever', () => {
    const s = addStrike(
      [
        { digest: 'old', count: 9, at: NOW - 31 * DAY },
        { digest: 'recent', count: 1, at: NOW - DAY },
      ],
      DIG,
      NOW,
    );
    expect(s.map((x) => x.digest).sort()).toEqual([DIG, 'recent'].sort());
  });

  test('a decayed strike restarts at one rather than resuming its old count', () => {
    const s = addStrike(
      [{ digest: DIG, count: 5, at: NOW - 31 * DAY }],
      DIG,
      NOW,
    );
    expect(s).toEqual([{ digest: DIG, count: 1, at: NOW }]);
  });

  test('round-trips through storage', () => {
    const s = [{ digest: DIG, count: 3, at: NOW }];
    expect(parseStrikes(serialiseStrikes(s))).toEqual(s);
  });

  test('drops records it cannot read rather than guessing a count', () => {
    // A guessed count escalates a ban: read 1 as 4 and a six-hour ban becomes two days.
    expect(parseStrikes('nonsense')).toEqual([]);
    expect(parseStrikes(`${DIG}|notanumber|2026-08-06T20:00:00.000Z`)).toEqual(
      [],
    );
    expect(parseStrikes(`${DIG}|2.5|2026-08-06T20:00:00.000Z`)).toEqual([]);
    expect(parseStrikes(`${DIG}|0|2026-08-06T20:00:00.000Z`)).toEqual([]);
    expect(parseStrikes(`${DIG}|-1|2026-08-06T20:00:00.000Z`)).toEqual([]);
    expect(parseStrikes(`${DIG}|3|not-a-date`)).toEqual([]);
    expect(parseStrikes(undefined)).toEqual([]);
  });

  test('the escalation composes: second offence is twice the first', () => {
    let strikes: ReturnType<typeof addStrike> = [];
    strikes = addStrike(strikes, DIG, NOW);
    const first = banDuration(strikesFor(strikes, DIG, NOW) - 1);
    strikes = addStrike(strikes, DIG, NOW + DAY);
    const second = banDuration(strikesFor(strikes, DIG, NOW + DAY) - 1);
    expect(second).toBe(first * 2);
  });
});

describe('dueForRevocation', () => {
  const rec = (until: string) => ({ digest: DIG, until: Date.parse(until) });

  test('splits expired from live', () => {
    const now = Date.parse('2026-08-06T20:00:00.000Z');
    const { expired, live } = dueForRevocation(
      [rec('2026-08-06T19:59:59.000Z'), rec('2026-08-06T20:00:01.000Z')],
      now,
    );
    expect(expired).toHaveLength(1);
    expect(live).toHaveLength(1);
  });

  test('a record due exactly now is expired', () => {
    // Ties revoke. The clock running out should release traffic, not hold it one more tick.
    const now = Date.parse('2026-08-06T20:00:00.000Z');
    expect(
      dueForRevocation([rec('2026-08-06T20:00:00.000Z')], now).expired,
    ).toHaveLength(1);
  });

  test('nothing stored means nothing to revoke and nothing live', () => {
    expect(dueForRevocation([], Date.now())).toEqual({ expired: [], live: [] });
  });
});
