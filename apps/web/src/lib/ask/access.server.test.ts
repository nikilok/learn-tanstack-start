import { describe, expect, test } from 'bun:test';

import { askStanding, mayAsk } from './access.server';

const yes = async () => true;
const no = async () => false;

describe('mayAsk', () => {
  test('the owner may ask, nobody else', async () => {
    expect(await mayAsk({ NODE_ENV: 'production' }, yes, false)).toBe(true);
    expect(await mayAsk({ NODE_ENV: 'production' }, no, false)).toBe(false);
    expect(await mayAsk({}, no, false)).toBe(false);
  });

  test('the local switch opens a development run to everyone, and nothing else', async () => {
    expect(
      await mayAsk({ NODE_ENV: 'development', ASK_LOCAL_OPEN: '1' }, no, false),
    ).toBe(true);
    expect(await mayAsk({ ASK_LOCAL_OPEN: '1' }, no, false)).toBe(false);
    expect(
      await mayAsk({ NODE_ENV: 'test', ASK_LOCAL_OPEN: '1' }, no, false),
    ).toBe(false);
    expect(
      await mayAsk(
        { NODE_ENV: 'development', ASK_LOCAL_OPEN: 'yes' },
        no,
        false,
      ),
    ).toBe(false);
  });

  test('production ignores the local switch whatever it says', async () => {
    expect(
      await mayAsk({ NODE_ENV: 'production', ASK_LOCAL_OPEN: '1' }, no, false),
    ).toBe(false);
    expect(
      await mayAsk({ NODE_ENV: 'production', ASK_LOCAL_OPEN: '1' }, yes, false),
    ).toBe(true);
  });

  test('while asking is public, every visitor may ask', async () => {
    expect(await mayAsk({ NODE_ENV: 'production' }, no, true)).toBe(true);
    expect(await mayAsk({}, no, true)).toBe(true);
  });
});

describe('askStanding', () => {
  test('the owner asks as the owner, public or not, local switch or not', async () => {
    for (const open of [true, false]) {
      expect(await askStanding({ NODE_ENV: 'production' }, yes, open)).toBe(
        'owner',
      );
      expect(
        await askStanding(
          { NODE_ENV: 'development', ASK_LOCAL_OPEN: '1' },
          yes,
          open,
        ),
      ).toBe('owner');
    }
  });

  test('a visitor asks as public only while asking is public', async () => {
    expect(await askStanding({ NODE_ENV: 'production' }, no, true)).toBe(
      'public',
    );
    expect(await askStanding({ NODE_ENV: 'production' }, no, false)).toBeNull();
  });

  test('a visitor of a local run opened to all asks as local, public or not', async () => {
    const env = { NODE_ENV: 'development', ASK_LOCAL_OPEN: '1' };
    expect(await askStanding(env, no, false)).toBe('local');
    expect(await askStanding(env, no, true)).toBe('local');
  });

  test('production never reads the local switch: a visitor there is public or nobody', async () => {
    const env = { NODE_ENV: 'production', ASK_LOCAL_OPEN: '1' };
    expect(await askStanding(env, no, true)).toBe('public');
    expect(await askStanding(env, no, false)).toBeNull();
  });
});
