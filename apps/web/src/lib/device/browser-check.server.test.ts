import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  type BrowserCheck,
  fromBrowser,
  localVerdict,
} from './browser-check.server';

// Passing `undefined` for the verdict takes the default, which reads this
// variable: cleared for every test, so a verdict set for a local run cannot
// change what they see, and restored after.
const VERDICT_ENV = 'BROWSER_CHECK_LOCAL_VERDICT';
const saved = process.env[VERDICT_ENV];
beforeEach(() => {
  delete process.env[VERDICT_ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[VERDICT_ENV];
  else process.env[VERDICT_ENV] = saved;
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

describe('fromBrowser', () => {
  test('a person is let through, and an automated client is not', async () => {
    expect(await fromBrowser(answering(false).check, undefined)).toBe(true);
    expect(await fromBrowser(answering(true).check, undefined)).toBe(false);
  });

  test('a verified crawler is refused like any automated client', async () => {
    expect(await fromBrowser(answering(true, true).check, undefined)).toBe(
      false,
    );
  });

  test('a local verdict is handed to the check as its development override, and nothing else is', async () => {
    const asked = answering(false);
    await fromBrowser(asked.check, 'BAD-BOT');
    await fromBrowser(asked.check, undefined);
    expect(asked.asked).toEqual([
      { developmentOptions: { bypass: 'BAD-BOT' } },
      undefined,
    ]);
  });

  test('a check that fails lets the request through, and says so', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = (async () => {
        throw new Error('service unreachable');
      }) as BrowserCheck;
      expect(await fromBrowser(failing, undefined)).toBe(true);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[1])).toContain(
        'service unreachable',
      );
    } finally {
      logged.mockRestore();
    }
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

  test('by default the verdict is read from the environment, and handed to the check', async () => {
    process.env[VERDICT_ENV] = 'BAD-BOT';
    expect(localVerdict()).toBe('BAD-BOT');
    const asked = answering(true);
    expect(await fromBrowser(asked.check)).toBe(false);
    expect(asked.asked).toEqual([
      { developmentOptions: { bypass: 'BAD-BOT' } },
    ]);
  });
});
