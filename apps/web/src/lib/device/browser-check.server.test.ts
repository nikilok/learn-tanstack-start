import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { CHECKED_CALLS } from './browser-check';
import { BROWSER_CHECK_LEVEL } from './browser-check-config';
import {
  type BrowserCheck,
  enforcing,
  fromBrowser,
  localVerdict,
} from './browser-check.server';

// Passing `undefined` for the verdict or the enforcement takes the default, which reads
// these variables: cleared for every test, so a value set for a local run cannot change
// what they see, and restored after.
const VERDICT_ENV = 'BROWSER_CHECK_LOCAL_VERDICT';
const ENFORCE_ENV = 'BROWSER_CHECK_ENFORCE';
const saved = {
  [VERDICT_ENV]: process.env[VERDICT_ENV],
  [ENFORCE_ENV]: process.env[ENFORCE_ENV],
};
let logged: ReturnType<typeof spyOn>;
beforeEach(() => {
  delete process.env[VERDICT_ENV];
  delete process.env[ENFORCE_ENV];
  logged = spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

/** A check answering with a fixed verdict, recording what it was asked. */
function answering(isBot: boolean, isVerifiedBot = false) {
  const asked: unknown[] = [];
  const check = (async (options?: unknown) => {
    asked.push(options);
    return { isHuman: !isBot, isBot, isVerifiedBot, bypassed: false };
  }) as BrowserCheck;
  return { check, asked };
}

/** What the check's verdicts were logged as. */
const said = () => logged.mock.calls.map((c: unknown[]) => String(c[0]));

describe('fromBrowser', () => {
  test('enforced: a person is let through, and an automated client is not', async () => {
    expect(await fromBrowser(answering(false).check, undefined, true)).toBe(
      true,
    );
    expect(await fromBrowser(answering(true).check, undefined, true)).toBe(
      false,
    );
    expect(said()).toEqual([
      '[extras] browser check: person',
      '[extras] browser check: automated',
    ]);
  });

  test('enforced: a verified crawler is refused like any automated client', async () => {
    expect(
      await fromBrowser(answering(true, true).check, undefined, true),
    ).toBe(false);
    expect(said()).toEqual(['[extras] browser check: verified crawler']);
  });

  test('not enforced: an automated client is let through, and the verdict is said all the same', async () => {
    expect(await fromBrowser(answering(true).check, undefined, false)).toBe(
      true,
    );
    expect(said()).toEqual([
      '[extras] browser check: automated (not enforced)',
    ]);
  });

  test('every check is asked at the shared level; a local verdict rides it as the development override', async () => {
    const asked = answering(false);
    await fromBrowser(asked.check, 'BAD-BOT', true);
    await fromBrowser(asked.check, undefined, true);
    expect(asked.asked).toEqual([
      {
        advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
        developmentOptions: { bypass: 'BAD-BOT' },
      },
      { advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL } },
    ]);
  });

  test("the level the server asks for is the one the client's protected calls name", () => {
    expect(BROWSER_CHECK_LEVEL).toBe('deepAnalysis');
    expect(
      CHECKED_CALLS.every(
        (c) => c.advancedOptions.checkLevel === BROWSER_CHECK_LEVEL,
      ),
    ).toBe(true);
  });

  test('a check that fails lets the request through, and says so', async () => {
    const failed = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = (async () => {
        throw new Error('service unreachable');
      }) as BrowserCheck;
      expect(await fromBrowser(failing, undefined, true)).toBe(true);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(String(failed.mock.calls[0]?.[1])).toContain(
        'service unreachable',
      );
    } finally {
      failed.mockRestore();
    }
  });

  test('by default the verdict and the enforcement are read from the environment', async () => {
    process.env[VERDICT_ENV] = 'BAD-BOT';
    process.env[ENFORCE_ENV] = '1';
    const asked = answering(true);
    expect(await fromBrowser(asked.check)).toBe(false);
    expect(asked.asked).toEqual([
      {
        advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
        developmentOptions: { bypass: 'BAD-BOT' },
      },
    ]);
    // Unset, nothing is enforced.
    delete process.env[ENFORCE_ENV];
    expect(await fromBrowser(answering(true).check)).toBe(true);
  });
});

describe('localVerdict', () => {
  test('only a verdict BotID knows is asked for', () => {
    expect(localVerdict('BAD-BOT')).toBe('BAD-BOT');
    expect(localVerdict('HUMAN')).toBe('HUMAN');
    expect(localVerdict('GOOD-BOT')).toBe('GOOD-BOT');
    for (const value of [undefined, '', 'bad-bot', 'yes'])
      expect(localVerdict(value)).toBeUndefined();
  });

  test('by default the verdict is read from the environment', () => {
    process.env[VERDICT_ENV] = 'BAD-BOT';
    expect(localVerdict()).toBe('BAD-BOT');
  });
});

describe('enforcing', () => {
  test('only `1` enforces', () => {
    expect(enforcing('1')).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(enforcing(value)).toBe(false);
  });
});
