// The view's job is to make a shared build line readable without deciding anything on it.

import { describe, expect, test } from 'bun:test';

import { type KinReport, type Standing } from './kin-report';
import { kinLines } from './kin-view';
import { lineText } from './line-model';
import { rollingWindow } from './time-window';

const W = rollingWindow(144, new Date('2026-08-25T12:00:00.000Z'));
const D = 't13dscrp00_aaaaaaaaaaaa_222222222222';

const member = (
  over: Partial<KinReport['families'][0]['members'][0]> = {},
) => ({
  digest: D,
  requests: 300,
  renderShare: 0,
  verified: false,
  standing: null as Standing,
  ...over,
});
const report = (over: Partial<KinReport> = {}): KinReport => ({
  window: W,
  listed: 1,
  complete: true,
  unreadable: [],
  families: [
    {
      family: 't13dscrp00_aaaaaaaaaaaa',
      standing: 'denied',
      members: [member()],
    },
  ],
  ...over,
});
const text = (r: KinReport) => kinLines(r).map(lineText).join('\n');

describe('kinLines', () => {
  test('a non-rendering unlisted member is shown and counted as worth a look', () => {
    const t = text(report());
    expect(t).toContain(D);
    expect(t).toContain('renders nothing');
    expect(t).toContain('1 member(s) not yet acted on');
  });

  test('a rendering member is called a browser, not a candidate', () => {
    const t = text(
      report({
        families: [
          {
            family: 't13dscrp00_aaaaaaaaaaaa',
            standing: 'denied',
            members: [member({ renderShare: 0.6 })],
          },
        ],
      }),
    );
    expect(t).toContain('a browser ran the app');
    expect(t).toContain(
      'every member of every line is already listed or verified',
    );
  });

  test('a verified crawler is named as one and never counted as a candidate', () => {
    const t = text(
      report({
        families: [
          {
            family: 't13dscrp00_aaaaaaaaaaaa',
            standing: 'denied',
            members: [member({ verified: true })],
          },
        ],
      }),
    );
    expect(t).toContain('verified crawler');
    expect(t).not.toContain('1 member(s) not yet acted on');
  });

  test('a DENIED line says its evidence cannot see the denied member', () => {
    expect(text(report())).toContain('never reaches routing');
  });

  test('a CHALLENGED line says a low share may be our own doing', () => {
    const t = text(
      report({
        families: [
          {
            family: 't13dscrp00_aaaaaaaaaaaa',
            standing: 'challenged',
            members: [member()],
          },
        ],
      }),
    );
    expect(t).toContain('may be ours');
  });

  test('an unread list is never reported as "nothing is listed"', () => {
    // The zero is there because we failed to read our own config, not because the WAF is empty.
    const s = text(
      report({ listed: 0, families: [], unreadable: ['FW_BLOCKED_JA4: boom'] }),
    );
    expect(s).toContain('could not read');
    expect(s).not.toContain('nothing is denied or challenged');
  });

  test('a capped sample makes the candidate count a floor, not an answer', () => {
    expect(text(report({ complete: false }))).toContain(
      'treat that as a floor',
    );
  });

  test('nothing listed says so rather than rendering an empty report', () => {
    const t = text(report({ listed: 0, families: [] }));
    expect(t).toContain('no build line to follow');
  });

  test('a truncated sample is warned about, not absorbed into the shares', () => {
    expect(text(report({ complete: false }))).toContain('group cap');
  });

  test('a line with no traffic says so rather than reading as clean', () => {
    const t = text(
      report({
        families: [
          {
            family: 't13dscrp00_aaaaaaaaaaaa',
            standing: 'denied',
            members: [],
          },
        ],
      }),
    );
    expect(t).toContain('no traffic in this window');
  });
});
