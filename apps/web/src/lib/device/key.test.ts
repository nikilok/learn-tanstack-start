import { describe, expect, test } from 'bun:test';

import {
  createPinger,
  DEVICE_KEY_RE,
  engagedPingPath,
  presentPingPath,
  viewPingPath,
} from './key';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';

describe('DEVICE_KEY_RE', () => {
  test('accepts exactly 32 lowercase hex characters', () => {
    expect(DEVICE_KEY_RE.test(KEY)).toBe(true);
    expect(DEVICE_KEY_RE.test('0'.repeat(32))).toBe(true);
  });

  test('rejects everything else', () => {
    for (const bad of [
      '',
      KEY.slice(1), // 31 chars
      `${KEY}0`, // 33 chars
      KEY.toUpperCase(), // hex, wrong case
      `${KEY.slice(0, 31)}g`, // not hex
      `${KEY.slice(0, 31)}/`, // path syntax
    ]) {
      expect(DEVICE_KEY_RE.test(bad)).toBe(false);
    }
  });
});

describe('ping paths', () => {
  test('build the routes the Nitro handler files answer at', () => {
    expect(presentPingPath(KEY)).toBe(`/api/p/${KEY}`);
    expect(viewPingPath(KEY)).toBe(`/api/v/${KEY}`);
    expect(engagedPingPath(KEY)).toBe(`/api/e/${KEY}`);
  });
});

describe('createPinger', () => {
  function boot() {
    const sent: string[] = [];
    const pinger = createPinger((path) => sent.push(path));
    return { sent, pinger };
  }

  test('sends nothing before a key is ready', () => {
    const { sent, pinger } = boot();
    pinger.view();
    pinger.view();
    pinger.engage();
    expect(sent).toEqual([]);
  });

  test('flushes the presence ping, queued views and the engaged signal when the key arrives', () => {
    const { sent, pinger } = boot();
    pinger.present();
    pinger.view();
    pinger.view();
    pinger.engage();
    pinger.ready(KEY);
    expect(sent).toEqual([
      presentPingPath(KEY),
      viewPingPath(KEY),
      viewPingPath(KEY),
      engagedPingPath(KEY),
    ]);
  });

  test('the presence ping needs no input and fires at most once per document', () => {
    const { sent, pinger } = boot();
    pinger.present();
    pinger.ready(KEY);
    pinger.present();
    expect(sent).toEqual([presentPingPath(KEY)]);
  });

  test('sends straight through once the key is ready', () => {
    const { sent, pinger } = boot();
    pinger.ready(KEY);
    pinger.view();
    expect(sent).toEqual([viewPingPath(KEY)]);
  });

  test('the engaged signal fires at most once per document', () => {
    const { sent, pinger } = boot();
    pinger.ready(KEY);
    pinger.engage();
    pinger.engage();
    expect(sent).toEqual([engagedPingPath(KEY)]);
  });

  test('a malformed key readies nothing and a second key is ignored', () => {
    const { sent, pinger } = boot();
    pinger.view();
    pinger.ready('not-a-key');
    expect(sent).toEqual([]);
    pinger.ready(KEY);
    pinger.ready('f'.repeat(32));
    pinger.view();
    expect(sent).toEqual([viewPingPath(KEY), viewPingPath(KEY)]);
  });
});
