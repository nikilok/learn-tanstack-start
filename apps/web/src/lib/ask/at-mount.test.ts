import { describe, expect, test } from 'bun:test';

import { hasOwnerHint } from './access-hint';
import { askAtMount } from './at-mount';

const UNTIL = 1_800_000_000_000;

/** Runs `read` in a document whose cookies are `cookies`, then puts back whatever document there was. */
function withCookies<T>(cookies: string, read: () => T): T {
  // Every test file shares one global: the property goes back exactly as it was found.
  const found = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { cookie: cookies },
    configurable: true,
    writable: true,
  });
  try {
    return read();
  } finally {
    if (found) Object.defineProperty(globalThis, 'document', found);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

/** What the home route learns in a browser holding `cookies` and a stored time, while asking is public or not. */
const learnt = (cookies: string, stored: number | null, open = true) =>
  withCookies(cookies, () =>
    askAtMount({ preview: false, owner: hasOwnerHint(), open, stored }),
  );

describe('askAtMount', () => {
  test('a visitor’s device that is waiting is told at once: the time kept for it is shown', () => {
    expect(
      askAtMount({ preview: false, owner: false, open: true, stored: UNTIL }),
    ).toEqual({ access: 'open', cooldown: UNTIL });
  });

  test('a device that is not waiting is shown no wait', () => {
    expect(
      askAtMount({ preview: false, owner: false, open: true, stored: null }),
    ).toEqual({ access: 'open', cooldown: null });
  });

  test('the owner is offered asking whether it is public or not, and waits out no time kept from a visit without the cookie', () => {
    for (const open of [true, false])
      expect(
        askAtMount({ preview: false, owner: true, open, stored: UNTIL }),
      ).toEqual({ access: 'open', cooldown: null });
  });

  test('while asking is not public, nobody but the owner is offered it', () => {
    expect(
      askAtMount({ preview: false, owner: false, open: false, stored: null })
        .access,
    ).toBe('off');
  });

  test('the /download preview never asks, the owner’s included', () => {
    for (const owner of [true, false])
      expect(
        askAtMount({ preview: true, owner, open: true, stored: null }).access,
      ).toBe('off');
  });
});

describe('a reload after the owner’s credential has lapsed', () => {
  test('while the hint is still in the browser, the page reads as the owner’s and the time kept for the device is not shown', () => {
    expect(learnt('theme=dark; ss-owner-hint=1', UNTIL)).toEqual({
      access: 'open',
      cooldown: null,
    });
  });

  test('once the document has taken the hint off (access-hint.server), the same browser is a visitor’s and is shown the time it was told', () => {
    expect(learnt('theme=dark', UNTIL)).toEqual({
      access: 'open',
      cooldown: UNTIL,
    });
    expect(learnt('', UNTIL).cooldown).toBe(UNTIL);
  });

  test('a cookie that only looks like the hint is not one', () => {
    expect(learnt('not-ss-owner-hint=1; ss-owner-hint-old=1', UNTIL)).toEqual({
      access: 'open',
      cooldown: UNTIL,
    });
  });

  test('with no document at all, nothing is read as a hint', () => {
    expect(hasOwnerHint()).toBe(false);
  });
});
