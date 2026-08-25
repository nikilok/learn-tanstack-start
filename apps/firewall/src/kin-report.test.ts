// A build line is shared. This report exists to SHOW one, not to decide who on it is a rebuild,
// so the tests are mostly about evidence surviving to the operator rather than being ruled on.

import { describe, expect, test } from 'bun:test';

import { type Standing, buildKinReport } from './kin-report';
import { rollingWindow } from './time-window';

const W = rollingWindow(144, new Date('2026-08-25T12:00:00.000Z'));
const DENIED = 't13dscrp00_aaaaaaaaaaaa_111111111111';
const SIBLING = 't13dscrp00_aaaaaaaaaaaa_222222222222';
const CHALLENGED = 't13dscrp00_aaaaaaaaaaaa_333333333333';
const OTHER = 't13dbingh2_444444444444_555555555555';

const PAGE = '/company/[slug]';
const RPC = '/_serverFn/abc';
const row = (digest: string, route: string, count_sum: number) => ({
  clientJa4Digest: digest,
  route,
  count_sum,
});
const ver = (digest: string, botVerified: string, count_sum = 1) => ({
  clientJa4Digest: digest,
  botVerified,
  count_sum,
});
const standings = (...e: [string, Standing][]) => new Map(e);

describe('buildKinReport', () => {
  test('a sibling of a denied digest appears on its line', () => {
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 300)],
      [],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families).toHaveLength(1);
    expect(r.families[0]?.members.map((m) => m.digest)).toEqual([SIBLING]);
  });

  test('a digest on an unrelated line is not shown', () => {
    const r = buildKinReport(
      W,
      [row(OTHER, PAGE, 300)],
      [],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.members).toEqual([]);
  });

  test('the rendering share is carried, not thresholded away', () => {
    // The whole point of showing the line: the operator sees 90% and 0% side by side and judges.
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 100), row(SIBLING, RPC, 900)],
      [],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.members[0]?.renderShare).toBeCloseTo(0.9, 5);
  });

  test('a member already on a list says which one', () => {
    const r = buildKinReport(
      W,
      [row(DENIED, PAGE, 10), row(CHALLENGED, PAGE, 10)],
      [],
      standings([DENIED, 'denied'], [CHALLENGED, 'challenged']),
      true,
    );
    const by = Object.fromEntries(
      (r.families[0]?.members ?? []).map((m) => [m.digest, m.standing]),
    );
    expect(by[DENIED]).toBe('denied');
    expect(by[CHALLENGED]).toBe('challenged');
  });

  test('a line carrying a DENIED member reports denied, not the lesser tier', () => {
    // A denied request never reaches routing, so it contributes no rows at all — a stronger
    // censorship of this window's evidence than a challenge, and the caveat must say so.
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 10)],
      [],
      standings([CHALLENGED, 'challenged'], [DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.standing).toBe('denied');
  });

  test('a verified crawler is flagged rather than hidden', () => {
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 300)],
      [ver(SIBLING, 'pass')],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.members[0]?.verified).toBe(true);
  });

  test("botVerified's value is 'pass', so anything else is not verified", () => {
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 300)],
      [ver(SIBLING, 'true')],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.members[0]?.verified).toBe(false);
  });

  test('a listed line with no traffic is still shown, as a line with no members', () => {
    // Absent is not the same as quiet, and dropping the line entirely would hide the fact that
    // something we denied has a build line at all.
    const r = buildKinReport(W, [], [], standings([DENIED, 'denied']), true);
    expect(r.families).toHaveLength(1);
    expect(r.families[0]?.members).toEqual([]);
  });

  test('nothing listed means no lines and a zero the view can report', () => {
    const r = buildKinReport(W, [row(SIBLING, PAGE, 300)], [], new Map(), true);
    expect(r.listed).toBe(0);
    expect(r.families).toEqual([]);
  });

  test('members are ordered by volume', () => {
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 5), row(CHALLENGED, PAGE, 500)],
      [],
      standings([DENIED, 'denied']),
      true,
    );
    expect(r.families[0]?.members.map((m) => m.requests)).toEqual([500, 5]);
  });

  test('a truncated sample is carried through, not silently absorbed', () => {
    const r = buildKinReport(W, [], [], standings([DENIED, 'denied']), false);
    expect(r.complete).toBe(false);
  });

  test('a malformed listed entry contributes no line', () => {
    const r = buildKinReport(
      W,
      [row(SIBLING, PAGE, 300)],
      [],
      standings(['nonsense', 'denied']),
      true,
    );
    expect(r.families).toEqual([]);
  });
});
