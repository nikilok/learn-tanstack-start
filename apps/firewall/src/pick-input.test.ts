// The identity picker's input path. Two kinds share one field, and every rule here differs
// between them — which is exactly where a shared field goes wrong.

import { describe, expect, test } from 'bun:test';

import {
  busiestCap,
  filterIdentities,
  normalizeIdentity,
  resolveSubject,
  subjectsToOpen,
  typeIdentity,
} from './pick-input';

const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';

describe('normalizeIdentity', () => {
  test('a JA4 is lower-cased — dashboards render hashes upper-case', () => {
    expect(normalizeIdentity('ja4', DIGEST.toUpperCase())).toBe(DIGEST);
  });

  test('an IP is kept as written', () => {
    expect(normalizeIdentity('ip', '1.2.3.4')).toBe('1.2.3.4');
  });

  test('surrounding whitespace is dropped for both', () => {
    expect(normalizeIdentity('ip', '  1.2.3.4 ')).toBe('1.2.3.4');
    expect(normalizeIdentity('ja4', ` ${DIGEST} `)).toBe(DIGEST);
  });
});

describe('resolveSubject', () => {
  test('an IPv4 resolves', () => {
    expect(resolveSubject('ip', '1.2.3.4')).toEqual({
      subject: { kind: 'ip', value: '1.2.3.4' },
    });
  });

  test('an IPv6 resolves', () => {
    const out = resolveSubject('ip', '2a02:c7f:1234::1');
    expect('subject' in out).toBe(true);
  });

  test('a JA4 resolves lower-cased, whatever case it was pasted in', () => {
    expect(resolveSubject('ja4', DIGEST.toUpperCase())).toEqual({
      subject: { kind: 'ja4', value: DIGEST },
    });
  });

  test('a blank field is refused rather than opening an empty tab', () => {
    expect(resolveSubject('ip', '   ')).toEqual({ error: 'not an IP address' });
  });

  // A JA4 contains letters and underscores an IP never can, so the two must not share a check.
  test('a JA4 typed into the IP field is refused', () => {
    expect(resolveSubject('ip', DIGEST)).toEqual({
      error: 'not an IP address',
    });
  });

  test('an IP typed into the JA4 field is refused', () => {
    expect(resolveSubject('ja4', '1.2.3.4')).toEqual({
      error: 'not a JA4 digest',
    });
  });

  test('a truncated digest is refused rather than queried as a handle that matches nothing', () => {
    expect(resolveSubject('ja4', 't13d1516h2')).toEqual({
      error: 'not a JA4 digest',
    });
  });

  // Found in review 2026-08-13. The check tested permitted CHARACTERS, so anything built from
  // digits, dots and colons resolved — opening a tab that queries an address that cannot exist.
  describe('the whole literal, not just its characters', () => {
    const refused = (v: string) =>
      expect(resolveSubject('ip', v)).toEqual({ error: 'not an IP address' });
    const accepted = (v: string) =>
      expect(resolveSubject('ip', v)).toEqual({
        subject: { kind: 'ip', value: v },
      });

    test('an octet above 255 is refused', () => {
      refused('999.999.999.999');
      refused('1.2.3.256');
    });

    test('the wrong number of octets is refused', () => {
      refused('1.2.3');
      refused('1.2.3.4.5');
      refused('....');
    });

    test('an empty or leading-zero octet is refused', () => {
      // A leading zero is read as octal by some resolvers, so it is not the address it looks like.
      refused('1..3.4');
      refused('01.2.3.4');
    });

    test('bare punctuation is refused', () => {
      refused('.');
      refused(':');
      refused('...');
    });

    test('ordinary IPv4 still resolves, including the edges', () => {
      accepted('1.2.3.4');
      accepted('0.0.0.0');
      accepted('255.255.255.255');
    });

    // Looser on purpose: a rejected address is one the operator can SEE in the traffic and
    // cannot look up, which costs more than an empty tab.
    test('the IPv6 forms that show up in traffic still resolve', () => {
      accepted('2a02:c7f:1234::1');
      accepted('::1');
      accepted('2001:db8:0:0:0:0:0:1');
      accepted('::ffff:1.2.3.4');
      // All-zeros. It has no groups at all, so the emptiness guard used to refuse it.
      accepted('::');
    });

    // The observability filter matches clientIp literally, so an upper-case digest would query a
    // value the API never returns.
    test('IPv6 resolves to its canonical lower-case form', () => {
      expect(resolveSubject('ip', '2A02:C7F:1234::1')).toEqual({
        subject: { kind: 'ip', value: '2a02:c7f:1234::1' },
      });
    });

    test('IPv4 is left exactly as written — it has no case to fold', () => {
      accepted('1.2.3.4');
    });

    test('IPv6 with two elisions or too many groups is refused', () => {
      refused('1::2::3');
      refused('1:2:3:4:5:6:7:8:9');
    });

    // Counting groups rather than requiring eight of them accepted both of these.
    test('too FEW groups without an elision is refused', () => {
      refused('1:2:3');
      refused('2a02:c7f:1234');
    });

    test('three colons is not an elision either', () => {
      refused('1:::2');
      refused(':::1');
      refused('1:::');
    });

    test('a lone leading or trailing colon is not an elision', () => {
      refused(':1:2:3:4:5:6:7');
      refused('1:2:3:4:5:6:7:');
    });

    test('an IPv4 tail counts as the two groups it stands for', () => {
      accepted('1:2:3:4:5:6:1.2.3.4'); // six groups + a tail = eight
      refused('1:2:3:4:5:6:7:1.2.3.4'); // seven + a tail = nine
    });

    test('a hex group longer than four digits is refused', () => {
      refused('2a02:c7f12345::1');
    });
  });
});

describe('typeIdentity', () => {
  test('accepts the characters an address is made of', () => {
    expect(typeIdentity('ip', '', '1.2.3.4')).toBe('1.2.3.4');
    expect(typeIdentity('ip', '2a02:', 'c7f::1')).toBe('2a02:c7f::1');
  });

  // Requiring the whole chunk to match meant pasting an IP silently did nothing.
  test('a paste is filtered within the chunk, not rejected whole', () => {
    expect(typeIdentity('ip', '', 'ip 1.2.3.4')).toBe('1.2.3.4');
  });

  test('the JA4 field accepts letters and underscores the IP field must not', () => {
    expect(typeIdentity('ja4', '', DIGEST)).toBe(DIGEST);
    expect(typeIdentity('ip', '', DIGEST)).not.toBe(DIGEST);
  });

  test('the field is bounded at the longest address that exists', () => {
    expect(typeIdentity('ip', '', '1'.repeat(80)).length).toBe(45);
  });

  test('a newline does not survive into either field', () => {
    expect(typeIdentity('ip', '', '1.2.3.4\n')).toBe('1.2.3.4');
    expect(typeIdentity('ja4', '', `${DIGEST}\n`)).toBe(DIGEST);
  });
});

describe('filterIdentities', () => {
  const rows: [string, number][] = [
    ['1.2.3.4', 900],
    ['5.6.7.8', 500],
    ['10.0.3.44', 100],
  ];

  test('a blank query keeps everything, in rank order', () => {
    expect(filterIdentities(rows, '')).toEqual(rows);
  });

  // An IP is often recognised by its tail as much as its network part.
  test('matches on a substring, not just a prefix', () => {
    expect(filterIdentities(rows, '3.4').map(([id]) => id)).toEqual([
      '1.2.3.4',
      '10.0.3.44',
    ]);
  });

  test('no match yields nothing rather than the unfiltered list', () => {
    expect(filterIdentities(rows, '99')).toEqual([]);
  });

  test('the ranking survives filtering', () => {
    expect(filterIdentities(rows, '.').map(([, n]) => n)).toEqual([
      900, 500, 100,
    ]);
  });

  // Found in review 2026-08-13. The JA4 field accepts upper case (its typed filter is /i), and
  // dashboards render digests upper case, so a pasted digest filtered the list to nothing while
  // Enter on the same text would have resolved it — the picker looked empty, not wrong.
  describe('case', () => {
    const digests: [string, number][] = [
      ['t13d1516h2_8daaf6152771_b0da82dd1658', 400],
      ['t13d1517h2_8daaf6152771_02713d6af862', 200],
    ];

    test('an upper-case query matches lower-case rows', () => {
      expect(filterIdentities(digests, 'T13D1516H2').map(([id]) => id)).toEqual(
        ['t13d1516h2_8daaf6152771_b0da82dd1658'],
      );
    });

    test('a whole digest pasted upper-case matches its row', () => {
      const [[id]] = digests;
      expect(filterIdentities(digests, id.toUpperCase())).toHaveLength(1);
    });

    test('a lower-case query matches upper-case rows, since the API may return either', () => {
      const upper: [string, number][] = digests.map(([id, n]) => [
        id.toUpperCase(),
        n,
      ]);
      expect(filterIdentities(upper, 't13d1516h2')).toHaveLength(1);
    });

    test('whatever the case, filtering still narrows rather than matching everything', () => {
      expect(filterIdentities(digests, 'T13D1517H2')).toHaveLength(1);
      expect(filterIdentities(digests, 'ZZZZ')).toHaveLength(0);
    });

    test('IPv6 hex matches in either case too', () => {
      const v6: [string, number][] = [['2a02:c7f:1234::1', 50]];
      expect(filterIdentities(v6, '2A02:C7F')).toHaveLength(1);
    });
  });
});

describe('busiestCap', () => {
  test('a tall pane allows the maximum', () => {
    expect(busiestCap(40, 10, 10, 20)).toBe(20);
  });

  test('a short pane is still allowed the minimum, not zero rows', () => {
    // reportH bottoms out at 8, and a picker showing nothing is worse than one that overflows.
    expect(busiestCap(8, 10, 10, 20)).toBe(10);
  });

  test('the cap is never exceeded however tall the pane', () => {
    expect(busiestCap(500, 10, 10, 20)).toBe(20);
  });

  test('a mid-height pane gets the room it actually has', () => {
    expect(busiestCap(25, 10, 10, 20)).toBe(15);
  });
});

describe('subjectsToOpen', () => {
  const rows: [string, number][] = Array.from({ length: 12 }, (_, i) => [
    `1.2.3.${i}`,
    100 - i,
  ]);

  // Each subject costs a profile's worth of queries, so one keypress must stay bounded.
  test('opens at most the cap, however long the list', () => {
    expect(subjectsToOpen(rows, 'ip', 8)).toHaveLength(8);
  });

  test('takes the busiest first, matching what is on screen', () => {
    expect(subjectsToOpen(rows, 'ip', 3).map((s) => s.value)).toEqual([
      '1.2.3.0',
      '1.2.3.1',
      '1.2.3.2',
    ]);
  });

  test('a short list opens all of it', () => {
    expect(subjectsToOpen(rows.slice(0, 2), 'ip', 8)).toHaveLength(2);
  });

  test('an empty list opens nothing, so the keypress is a no-op', () => {
    expect(subjectsToOpen([], 'ip', 8)).toEqual([]);
  });

  test('JA4 subjects are normalized, so a tab is never opened on an unqueryable handle', () => {
    const out = subjectsToOpen([[DIGEST.toUpperCase(), 10]], 'ja4', 8);
    expect(out[0]).toEqual({ kind: 'ja4', value: DIGEST });
  });
});
