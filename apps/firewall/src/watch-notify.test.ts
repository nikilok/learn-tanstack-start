// An alerting path fails in two silent ways: it repeats until it is ignored, or it stops working
// and nothing says so. Both look identical to a quiet week.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rollingWindow } from './time-window';
import type { WatchReport } from './watch';
import {
  INVESTIGATED,
  NOTIFY_STATE,
  actionableKey,
  concludedKey,
  concludedText,
  iMessageArgs,
  notifyText,
  readInvestigated,
  shouldNotify,
  writeInvestigated,
  rememberNotified,
  shortDigest,
} from './watch-notify';

const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const base: WatchReport = {
  window: rollingWindow(6, new Date('2026-08-06T12:00:00.000Z')),
  screened: 0,
  fingerprints: 0,
  candidates: 0,
  truncated: false,
  findings: [],
  enforcement: [],
  reachability: [],
  errors: [],
};
const ban = (digest: string) => ({
  digest,
  allowed: 900,
  total: 900,
  why: [],
  advice: {
    verdict: 'ban' as const,
    reasons: [],
    blockers: [],
    leverNotes: [],
  },
  autoBanRefusal: 'fixture: not evaluated',
});

describe('actionableKey', () => {
  test('nothing actionable is an empty key', () => {
    expect(actionableKey(base)).toBe('');
  });

  test('the same finding gives the same key on a later run', () => {
    // Counts and windows are deliberately excluded: the same fingerprint an hour later, with a
    // different request total, is not news. Including them would notify every single run.
    const a = { ...base, findings: [ban(DIG)] };
    const b = {
      ...base,
      findings: [{ ...ban(DIG), allowed: 5000, total: 5000 }],
      window: rollingWindow(6, new Date('2026-08-06T18:00:00.000Z')),
    };
    expect(actionableKey(a)).toBe(actionableKey(b));
  });

  test('a different fingerprint is a different key', () => {
    expect(actionableKey({ ...base, findings: [ban(DIG)] })).not.toBe(
      actionableKey({ ...base, findings: [ban('t13dothr00_aaa_bbb')] }),
    );
  });

  test('order does not change the key', () => {
    const one = { ...base, findings: [ban('a'), ban('b')] };
    const two = { ...base, findings: [ban('b'), ban('a')] };
    expect(actionableKey(one)).toBe(actionableKey(two));
  });

  test('a broken rule and a failed run are each their own news', () => {
    expect(actionableKey({ ...base, enforcement: ['x'] })).not.toBe('');
    expect(actionableKey({ ...base, reachability: ['x'] })).not.toBe('');
    // Distinct keys, or a reachability alarm would be silenced by an enforcement one
    // already reported with the same text.
    expect(actionableKey({ ...base, reachability: ['x'] })).not.toBe(
      actionableKey({ ...base, enforcement: ['x'] }),
    );
    expect(actionableKey({ ...base, errors: ['y'] })).not.toBe('');
    expect(actionableKey({ ...base, truncated: true })).not.toBe('');
  });

  test('a truncated screen that DID see fingerprints is not news', () => {
    expect(actionableKey({ ...base, truncated: true, fingerprints: 3 })).toBe(
      '',
    );
  });
});

describe('shouldNotify', () => {
  test('nothing actionable never notifies', async () => {
    expect(await shouldNotify('/nonexistent', '')).toBe(false);
  });

  test('an unreadable state file notifies', async () => {
    // Staying quiet because we could not remember is the one outcome that turns a lost file into
    // a missed scraper.
    expect(await shouldNotify('/nonexistent', 'ban:x')).toBe(true);
  });
});

describe('notifyText', () => {
  test('says what kind of thing was found, without a digest', () => {
    // A lock-screen banner is a poor place for a 36-character hex string, and the detail is in
    // the log for whoever sits down.
    const t = notifyText({ ...base, findings: [ban(DIG)] });
    expect(t).toContain('1 fingerprint');
    expect(t).not.toContain(DIG);
  });

  test('reports several kinds at once', () => {
    const t = notifyText({
      ...base,
      findings: [ban(DIG)],
      enforcement: ['x'],
      errors: ['y'],
    });
    expect(t).toContain('worth denying');
    expect(t).toContain('not enforcing');
    expect(t).toContain('error');
  });

  test('never produces an empty message', () => {
    expect(notifyText(base).length).toBeGreaterThan(0);
  });
});

describe('iMessageArgs', () => {
  test('passes the handle and body as arguments, not script text', () => {
    const a = iMessageArgs('+441234567890', 'hello');
    expect(a[a.length - 2]).toBe('+441234567890');
    expect(a[a.length - 1]).toBe('hello');
  });

  test('an apostrophe in the body cannot break the script', () => {
    // Interpolated, this would close the AppleScript string and fail as a syntax error — with
    // nobody reading a notifier's stderr to find out.
    const body = "rule 'x' isn't enforcing";
    const a = iMessageArgs('+44', body);
    expect(a[a.length - 1]).toBe(body);
    expect(a[1]).not.toContain(body);
  });

  test('the script reads its inputs from argv', () => {
    expect(iMessageArgs('+44', 'b')[1]).toContain('on run argv');
  });
});

// The unattended run has no memory of its own, so this file IS the memory. Getting it wrong
// either bills for the same answer every hour or hides a finding nobody has seen.
describe('readInvestigated / writeInvestigated', () => {
  const NOW = Date.parse('2026-08-06T20:00:00.000Z');
  const DAY = 24 * 60 * 60_000;

  // Made per test, not hardcoded: writeInvestigated swallows a failed write by design, so a
  // directory that does not exist turns every setup into a silent no-op and the reads below
  // assert against nothing.
  let DIR: string;
  beforeEach(async () => {
    DIR = await mkdtemp(join(tmpdir(), 'fw-watch-'));
  });
  afterEach(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  test('the fixture directory is real, so a failed write cannot pass as an empty read', async () => {
    await writeInvestigated(DIR, new Map([[DIG, NOW]]));
    expect(await Bun.file(`${DIR}/${INVESTIGATED}`).exists()).toBe(true);
  });

  test('round-trips what it was given', async () => {
    await writeInvestigated(DIR, new Map([[DIG, NOW]]));
    expect(await readInvestigated(DIR, NOW)).toEqual(new Map([[DIG, NOW]]));
  });

  test('drops entries past the decay window', async () => {
    // A fingerprint that returns next week deserves a fresh look, and the file must not grow
    // for the life of the machine.
    await writeInvestigated(DIR, new Map([[DIG, NOW - 8 * DAY]]));
    expect(await readInvestigated(DIR, NOW)).toEqual(new Map());
  });

  test('keeps entries inside it', async () => {
    await writeInvestigated(DIR, new Map([[DIG, NOW - DAY]]));
    expect([...(await readInvestigated(DIR, NOW)).keys()]).toEqual([DIG]);
  });

  test('a missing file is empty, which re-investigates rather than skipping', async () => {
    // Paying twice is the cheaper mistake than never looking.
    expect(await readInvestigated('/nonexistent', NOW)).toEqual(new Map());
  });

  test('a malformed line is dropped without taking the good ones with it', async () => {
    await writeInvestigated(DIR, new Map([[DIG, NOW]]));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      `${DIR}/.firewall-watch-investigated`,
      '\nrubbish\nalso|notanumber',
    );
    expect([...(await readInvestigated(DIR, NOW)).keys()]).toEqual([DIG]);
  });

  test('digests are matched case-insensitively', async () => {
    await writeInvestigated(DIR, new Map([[DIG.toUpperCase(), NOW]]));
    expect((await readInvestigated(DIR, NOW)).has(DIG)).toBe(true);
  });
});

describe('concludedKey / concludedText', () => {
  test('no conclusion is an empty key, which never notifies', async () => {
    expect(concludedKey([])).toBe('');
    expect(await shouldNotify('/nonexistent', concludedKey([]))).toBe(false);
  });

  test('order does not change the key', () => {
    expect(concludedKey([`ban:${DIG}`, 'unclear:x'])).toBe(
      concludedKey(['unclear:x', `ban:${DIG}`]),
    );
  });

  test('cannot collide with a report key for the same digest', () => {
    // Both paths write the same state file. Without the namespace, `ban:<digest>` would mean two
    // different things in it and each would read the other as news.
    expect(concludedKey([`ban:${DIG}`])).not.toBe(
      actionableKey({ ...base, findings: [ban(DIG)] }),
    );
  });

  test('says which way it went, since unclear is not a ban', () => {
    // Asserted on the distinction rather than the phrasing — the wording has already changed
    // once (it used to be a bare count) and will again.
    const banned = concludedText([`ban:${DIG}`]);
    const unclear = concludedText(['unclear:x']);
    expect(banned).not.toEqual(unclear);
    expect(banned.toLowerCase()).toContain('deny');
    expect(unclear).toContain('inconclusive');
    const both = concludedText([`ban:${DIG}`, 'unclear:x']);
    expect(both.toLowerCase()).toContain('deny');
    expect(both).toContain('inconclusive');
  });

  test('never produces an empty message', () => {
    expect(concludedText([]).length).toBeGreaterThan(0);
  });
});

// Every file this module writes names live client fingerprints. Adding one and forgetting the
// .gitignore is a one-line mistake that publishes them, and nothing else would catch it.
describe('watch state files are gitignored', () => {
  test.each([NOTIFY_STATE, INVESTIGATED])('%s', async (name) => {
    const root = `${import.meta.dir}/../../..`;
    const ignore = await Bun.file(`${root}/.gitignore`).text();
    expect(ignore.split('\n').map((l) => l.trim())).toContain(name);
  });
});

// The two memories have to decay together. They were 7 days and forever, so a fingerprint that
// went away and came back was investigated again — paid for again — and then silenced.
describe('notification memory decays', () => {
  let DIR: string;
  beforeEach(async () => {
    DIR = await mkdtemp(join(tmpdir(), 'fw-notify-'));
  });
  afterEach(async () => {
    await rm(DIR, { recursive: true, force: true });
  });
  const NOW = Date.parse('2026-08-08T09:00:00.000Z');
  const DAY = 24 * 60 * 60_000;
  const KEY = 'concluded:ban:abc';

  test('the same finding stays quiet inside the window', () => {
    return (async () => {
      await rememberNotified(DIR, KEY, NOW);
      expect(await shouldNotify(DIR, KEY, NOW + DAY)).toBe(false);
    })();
  });

  test('the same finding notifies again once the memory has decayed', async () => {
    await rememberNotified(DIR, KEY, NOW);
    expect(await shouldNotify(DIR, KEY, NOW + 8 * DAY)).toBe(true);
  });

  test('a different finding always notifies', async () => {
    await rememberNotified(DIR, KEY, NOW);
    expect(await shouldNotify(DIR, 'concluded:ban:other', NOW + DAY)).toBe(
      true,
    );
  });

  test('a state file with no timestamp is treated as expired', async () => {
    // The pre-TTL format. Re-reporting once is the cheap mistake; a key from an unknown time
    // silencing a live finding is not.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${DIR}/${NOTIFY_STATE}`, KEY, 'utf8');
    expect(await shouldNotify(DIR, KEY, NOW)).toBe(true);
  });
});

// "1 inconclusive" on a phone says something happened and nothing about what — and the only
// reason this path exists is that nobody is reading stdout.
describe('concludedText names the identity', () => {
  const D = 't13d1711h2_5b57614c22b0_5894756fee65';

  test('an inconclusive verdict says WHICH fingerprint', () => {
    const out = concludedText([`unclear:${D}`]);
    expect(out).toContain('t13d1711h2');
    expect(out).toContain('5894756fee65'.slice(-8));
    expect(out).toContain('firewall-watch.log');
  });

  test('a ban reads as an instruction, not a count', () => {
    expect(concludedText([`ban:${D}`])).toContain('DENY');
  });

  test('both kinds appear, and are not conflated', () => {
    const out = concludedText([
      `ban:${D}`,
      'unclear:t13dother0_aaaaaaaaaaaa_bbbbbbbbbbbb',
    ]);
    expect(out).toContain('DENY');
    expect(out).toContain('inconclusive');
  });

  test('an empty conclusion still says so rather than sending a blank', () => {
    expect(concludedText([])).toBe('nothing conclusive');
  });

  test('the short form stays recognisable and phone-sized', () => {
    // The JA4_a profile carries the ALPN slot, which is the part an operator actually reads.
    expect(shortDigest(D).startsWith('t13d1711h2')).toBe(true);
    expect(shortDigest(D).length).toBeLessThan(22);
    expect(shortDigest('short')).toBe('short');
  });
});
