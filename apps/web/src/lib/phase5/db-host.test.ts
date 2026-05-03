import { describe, expect, test } from 'bun:test';
import { describeDbHost } from './db-host.ts';

describe('describeDbHost — happy path', () => {
  test('standard Postgres URL with port → returns host:port', () => {
    expect(
      describeDbHost('postgresql://user:secret@example.com:5432/mydb'),
    ).toBe('example.com:5432');
  });

  test('Neon-style host without explicit port → returns hostname', () => {
    expect(
      describeDbHost(
        'postgresql://u:p@ep-spring-butterfly.eu-west-2.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('ep-spring-butterfly.eu-west-2.aws.neon.tech');
  });

  test('postgres:// (no -ql) prefix is also handled', () => {
    expect(describeDbHost('postgres://u:p@host:5432/db')).toBe('host:5432');
  });

  test('IPv6 host wrapped in brackets', () => {
    expect(describeDbHost('postgresql://u:p@[::1]:5432/db')).toBe('[::1]:5432');
  });
});

describe('describeDbHost — non-string / malformed input', () => {
  test('undefined → "(not set)"', () => {
    expect(describeDbHost(undefined)).toBe('(not set)');
  });

  test('empty string → "(not set)"', () => {
    expect(describeDbHost('')).toBe('(not set)');
  });

  test('garbage with no @ → "(unparseable)"', () => {
    expect(describeDbHost('not a url')).toBe('(unparseable)');
  });

  test('URL without auth (no @ separator) → "(unparseable)"', () => {
    // Not a leak — there's no host segment to extract via this regex.
    // Defensible failure mode for our inputs (POSTGRES_URL always has auth).
    expect(describeDbHost('postgresql://host:5432/db')).toBe('(unparseable)');
  });

  test('malformed: unencoded @ in password → returns host (last @ wins)', () => {
    // Postgres URL syntax requires @ in password to be %40-encoded. If
    // someone sets a malformed URL anyway, the regex picks the last @ and
    // returns just the host segment — never a credential fragment.
    expect(describeDbHost('postgresql://user:p@ss@host/db')).toBe('host');
  });
});

describe('describeDbHost — credential leak resistance (the load-bearing tests)', () => {
  // Purposefully nasty values — these are the strings we MUST NOT see
  // anywhere in the output. If a future "improvement" widens the function
  // (e.g. swap to `new URL(url).toString()`), one of these assertions will
  // fail and block the change.
  const username = 'sneaky-user';
  const password = 'p@ssw0rd!#$%&-not-leaked';
  const dbName = 'top-secret-db';
  const queryParam = 'sslmode=require';
  const url = `postgresql://${username}:${encodeURIComponent(password)}@example.com:5432/${dbName}?${queryParam}`;

  const out = describeDbHost(url);

  test('output equals exactly the host:port', () => {
    expect(out).toBe('example.com:5432');
  });

  test('output does NOT contain the username', () => {
    expect(out).not.toContain(username);
  });

  test('output does NOT contain the password (encoded or raw)', () => {
    expect(out).not.toContain(password);
    expect(out).not.toContain(encodeURIComponent(password));
    // Spot-check pieces of the password to catch partial leaks.
    expect(out).not.toContain('p@ss');
    expect(out).not.toContain('w0rd');
  });

  test('output does NOT contain the database name', () => {
    expect(out).not.toContain(dbName);
    expect(out).not.toContain('top-secret');
  });

  test('output does NOT contain query parameters', () => {
    expect(out).not.toContain(queryParam);
    expect(out).not.toContain('sslmode');
    expect(out).not.toContain('require');
    expect(out).not.toContain('?');
  });

  test('output does NOT contain the @ separator', () => {
    expect(out).not.toContain('@');
  });

  test('output does NOT contain the path separator', () => {
    expect(out).not.toContain('/');
  });
});
