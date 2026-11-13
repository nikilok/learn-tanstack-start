import { describe, expect, test } from 'bun:test';

import { mayAsk } from './access.server';

const yes = async () => true;
const no = async () => false;

describe('mayAsk', () => {
  test('the owner may ask, nobody else', async () => {
    expect(await mayAsk({ NODE_ENV: 'production' }, yes)).toBe(true);
    expect(await mayAsk({ NODE_ENV: 'production' }, no)).toBe(false);
    expect(await mayAsk({}, no)).toBe(false);
  });

  test('the local switch opens a development run to everyone, and nothing else', async () => {
    expect(
      await mayAsk({ NODE_ENV: 'development', ASK_LOCAL_OPEN: '1' }, no),
    ).toBe(true);
    expect(await mayAsk({ ASK_LOCAL_OPEN: '1' }, no)).toBe(false);
    expect(await mayAsk({ NODE_ENV: 'test', ASK_LOCAL_OPEN: '1' }, no)).toBe(
      false,
    );
    expect(
      await mayAsk({ NODE_ENV: 'development', ASK_LOCAL_OPEN: 'yes' }, no),
    ).toBe(false);
  });

  test('production ignores the local switch whatever it says', async () => {
    expect(
      await mayAsk({ NODE_ENV: 'production', ASK_LOCAL_OPEN: '1' }, no),
    ).toBe(false);
    expect(
      await mayAsk({ NODE_ENV: 'production', ASK_LOCAL_OPEN: '1' }, yes),
    ).toBe(true);
  });
});
