import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { BrowserVerdict } from '../device/browser-check.server';
import type { AskStanding } from './access.server';
import { type AdmissionDeps, admitAsk, admitMint } from './admission.server';
import {
  type Budgets,
  HOLD_TOKENS,
  type Held,
  minimumCharge,
  mintCharge,
} from './allowance.server';

type Total = keyof Budgets;

const TOTALS = ['device', 'network', 'site'] as const satisfies Total[];
const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const NETWORK = 'net:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const SITE = 'all:test';
const KEYS = { device: KEY, network: NETWORK, site: SITE } satisfies Record<
  Total,
  string
>;
const TOKEN = 'a-live-token';
// Each total its own budget, so a charge measured on the wrong one shows.
const BUDGETS = {
  device: 1_000_000,
  network: 2_000_000,
  site: 5_000_000,
} satisfies Budgets;
const NONE: Budgets = { device: null, network: null, site: null };
const LEAST = minimumCharge(BUDGETS.device);
// A budget whose least charge is over HOLD_TOKENS.
const BIG_DEVICE = 40_000_000;
// What a visitor's mint is charged on its network, with the usual budgets.
const MINT = mintCharge(LEAST);
// When each total opens again.
const UNTIL = {
  device: 1_800_000_000_000,
  network: 1_800_000_100_000,
  site: 1_800_000_200_000,
} satisfies Record<Total, number>;
// The start of each total's window, as the database says it.
const OPENED = {
  device: '2026-11-21 14:05:00.123456+00',
  network: '2026-11-21 09:30:00.5+00',
  site: '2026-11-21 00:00:00.000001+00',
} satisfies Record<Total, string>;

type Setup = {
  standing?: AskStanding;
  listed?: boolean;
  budgets?: Partial<Budgets>;
  network?: string | null;
  cooling?: Partial<Record<Total, number | Error>>;
  hold?: Partial<Record<Total, Held | Error>>;
  settle?: Partial<Record<Total, Error>>;
  verdict?: BrowserVerdict | 'unchecked';
};

/** The steps as fakes, recording in order each step read, each hold taken with what it set aside, and each settle written with its window and what it gave up. */
function deps(setup: Setup = {}) {
  const read: string[] = [];
  const holds: { key: string; budget: number; reserve: number }[] = [];
  const settles: {
    key: string;
    opened: string;
    charge: number;
    reserve: number;
  }[] = [];
  const { standing = 'public', listed = false, verdict = 'person' } = setup;
  const budgets: Budgets = { ...BUDGETS, ...setup.budgets };
  const network = 'network' in setup ? (setup.network ?? null) : NETWORK;
  const keys = { ...KEYS, network };
  /** The total a key is the row of; a key no total is kept under is a failure. */
  const totalOf = (key: string): Total => {
    const total = TOTALS.find((name) => keys[name] === key);
    if (total === undefined) throw new Error(`no total is kept under ${key}`);
    return total;
  };
  const fakes: AdmissionDeps = {
    standing: async () => {
      read.push('standing');
      return standing;
    },
    tokenMatches: (token, key) => {
      read.push('token');
      return token === TOKEN && key === KEY;
    },
    listed: async () => {
      read.push('listed');
      return listed;
    },
    budgets: () => {
      read.push('budgets');
      return budgets;
    },
    network: () => {
      read.push('network');
      return network;
    },
    site: () => {
      read.push('site');
      return SITE;
    },
    cooling: async (key) => {
      const total = totalOf(key);
      read.push(`cooling ${total}`);
      const until = setup.cooling?.[total] ?? null;
      if (until instanceof Error) throw until;
      return until;
    },
    hold: async (key, budget, reserve) => {
      const total = totalOf(key);
      read.push(`hold ${total}`);
      holds.push({ key, budget, reserve });
      const held = setup.hold?.[total] ?? {
        admitted: true,
        opened: OPENED[total],
      };
      if (held instanceof Error) throw held;
      return held;
    },
    settle: async (key, opened, charge, _budget, reserve) => {
      const total = totalOf(key);
      read.push(`settle ${total}`);
      const failure = setup.settle?.[total];
      if (failure) throw failure;
      settles.push({ key, opened, charge, reserve });
    },
    verdict: async () => {
      read.push('verdict');
      return verdict;
    },
  };
  return { fakes, read, holds, settles };
}

/** One outcome for every total. */
function every<T>(value: T): Record<Total, T> {
  return { device: value, network: value, site: value };
}

/** A hold refused at a total, with that total's time. */
function refusedAt(total: Total): Partial<Record<Total, Held>> {
  return { [total]: { admitted: false, until: UNTIL[total] } };
}

/** A hold at a total whose room is taken up by asks still running. */
function busyAt(total: Total): Partial<Record<Total, Held>> {
  return { [total]: { admitted: false, busy: true } };
}

/** The holds taken on the named totals, each against its own budget and setting aside `reserve`, in order. */
function heldOn(totals: readonly Total[], reserve = HOLD_TOKENS) {
  return totals.map((total) => ({
    key: KEYS[total],
    budget: BUDGETS[total],
    reserve,
  }));
}

/** The named totals each settled at one charge in its own window, giving up `reserve`, in order. */
function settledAt(
  charge: number,
  totals: readonly Total[] = TOTALS,
  reserve = HOLD_TOKENS,
) {
  return totals.map((total) => ({
    key: KEYS[total],
    opened: OPENED[total],
    charge,
    reserve,
  }));
}

let logged: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  logged?.mockRestore();
  logged = undefined;
});

/** Silences and records what the admission says went wrong. */
function quiet() {
  logged = spyOn(console, 'error').mockImplementation(() => {});
  return logged;
}

describe('admitAsk', () => {
  test('a visitor is admitted once every step has passed, the cheap ones first and the billed check last, with nothing settled yet', async () => {
    const { fakes, read, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    expect(admission.status).toBe('admitted');
    expect(read).toEqual([
      'standing',
      'token',
      'listed',
      'budgets',
      'network',
      'site',
      'hold device',
      'hold network',
      'hold site',
      'verdict',
    ]);
    expect(settles).toEqual([]);
  });

  test('the three holds are taken in the order device, network, site, each against its own budget, before the check is asked', async () => {
    const { fakes, read, holds } = deps();
    await admitAsk(KEY, TOKEN, fakes);
    expect(holds).toEqual(heldOn(['device', 'network', 'site']));
    expect(read.slice(-4)).toEqual([
      'hold device',
      'hold network',
      'hold site',
      'verdict',
    ]);
  });

  test('an admitted ask is charged the tokens it used', async () => {
    const { fakes, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(settles.map(({ charge }) => charge)).toEqual([
      140_000, 140_000, 140_000,
    ]);
  });

  test('an admitted ask’s charge settles all three totals at the same amount, each in its own window', async () => {
    const { fakes, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(settles).toEqual(settledAt(140_000));
  });

  test('every settlement of an ask is made in the window its own hold was set in', async () => {
    const hold = {
      device: { admitted: true, opened: '2026-11-20 09:00:00+00' },
      network: { admitted: true, opened: '2026-11-19 18:00:00+00' },
      site: { admitted: true, opened: '2026-11-21 00:00:00+00' },
    } satisfies Record<Total, Held>;
    const windows = [hold.device.opened, hold.network.opened, hold.site.opened];
    const charged = deps({ hold });
    const admission = await admitAsk(KEY, TOKEN, charged.fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(charged.settles.map(({ opened }) => opened)).toEqual(windows);
    // The holds given back whole, and the ones a turned-away client is charged for or gives back.
    for (const verdict of ['unchecked', 'automated'] as const) {
      const { fakes, settles } = deps({ hold, verdict });
      await admitAsk(KEY, TOKEN, fakes);
      expect(settles.map(({ opened }) => opened)).toEqual(windows);
    }
  });

  test('an ask that used little, or nothing, is charged the least an ask costs', async () => {
    for (const used of [0, 4_000, LEAST - 1]) {
      const { fakes, settles } = deps();
      const admission = await admitAsk(KEY, TOKEN, fakes);
      if (admission.status !== 'admitted') throw new Error('not admitted');
      await admission.charge(used);
      expect(settles.map(({ charge }) => charge)).toEqual([
        LEAST,
        LEAST,
        LEAST,
      ]);
    }
  });

  test('the least an ask costs is measured on the device’s budget and charged to every total', async () => {
    expect(minimumCharge(BUDGETS.network)).not.toBe(LEAST);
    expect(minimumCharge(BUDGETS.site)).not.toBe(LEAST);
    const { fakes, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(0);
    expect(settles).toEqual(settledAt(LEAST));
  });

  test('a local run with no device budget measures the least on the first total it is counted against', async () => {
    const least = minimumCharge(BUDGETS.network);
    const { fakes, settles } = deps({
      standing: 'local',
      budgets: { device: null },
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(0);
    expect(settles).toEqual(settledAt(least, ['network', 'site']));
  });

  test('with the usual budgets every hold sets aside HOLD_TOKENS and every settle gives up the same', async () => {
    const { fakes, holds, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(holds.map(({ reserve }) => reserve)).toEqual(
      Array(3).fill(HOLD_TOKENS),
    );
    expect(settles.map(({ reserve }) => reserve)).toEqual(
      Array(3).fill(HOLD_TOKENS),
    );
  });

  test('where the least an ask costs is over HOLD_TOKENS, every total sets aside that least and every charge gives it up', async () => {
    const least = minimumCharge(BIG_DEVICE);
    expect(least).toBe(400_000);
    const { fakes, holds, settles } = deps({ budgets: { device: BIG_DEVICE } });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(0);
    expect(holds.map(({ key, reserve }) => [key, reserve])).toEqual([
      [KEY, least],
      [NETWORK, least],
      [SITE, least],
    ]);
    expect(
      settles.map(({ key, charge, reserve }) => [key, charge, reserve]),
    ).toEqual([
      [KEY, least, least],
      [NETWORK, least, least],
      [SITE, least, least],
    ]);
  });

  test('every hold given back gives up the same reserve its holds set aside, however the ask ended', async () => {
    quiet();
    for (const setup of [
      { hold: refusedAt('network') },
      { hold: busyAt('site') },
      { hold: { site: new Error('relation missing') } },
      { verdict: 'unchecked' },
    ] satisfies Setup[]) {
      const { fakes, holds, settles } = deps({
        ...setup,
        budgets: { device: BIG_DEVICE },
      });
      await admitAsk(KEY, TOKEN, fakes);
      expect(settles.length).toBeGreaterThan(0);
      expect(settles.map(({ charge }) => charge)).toEqual(
        Array(settles.length).fill(0),
      );
      expect(settles.map(({ reserve }) => reserve)).toEqual(
        Array(settles.length).fill(400_000),
      );
      expect(holds.map(({ reserve }) => reserve)).toEqual(
        Array(holds.length).fill(400_000),
      );
    }
  });

  test('a local run with no device budget measures what it sets aside on the first total it is counted against', async () => {
    const { fakes, holds, settles } = deps({
      standing: 'local',
      budgets: { device: null, network: BIG_DEVICE },
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(0);
    expect(holds.map(({ key, reserve }) => [key, reserve])).toEqual([
      [NETWORK, 400_000],
      [SITE, 400_000],
    ]);
    expect(settles.map(({ reserve }) => reserve)).toEqual([400_000, 400_000]);
  });

  test('an ask is charged once on each total, however often its charge is called', async () => {
    const { fakes, settles } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(50_000);
    await admission.charge(90_000);
    expect(settles).toEqual(settledAt(50_000));
  });

  test('a charge that cannot be written is said for each total and never thrown: the answer already given stands', async () => {
    const said = quiet();
    const { fakes } = deps({ settle: every(new Error('network down')) });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await expect(admission.charge(50_000)).resolves.toBeUndefined();
    expect(said).toHaveBeenCalledTimes(3);
    for (const call of said.mock.calls)
      expect(String(call[0])).toBe('[ask] usage could not be settled:');
  });

  test('a settle that fails on one total is said, the other totals are still settled, and the charge does not throw', async () => {
    const said = quiet();
    const { fakes, settles } = deps({
      settle: { network: new Error('network down') },
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await expect(admission.charge(50_000)).resolves.toBeUndefined();
    expect(settles).toEqual(settledAt(50_000, ['device', 'site']));
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be settled:',
    );
  });

  test('a request that may not ask is denied before anything else is read', async () => {
    const { fakes, read } = deps({ standing: null });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(read).toEqual(['standing']);
  });

  test('a token not issued for the key is denied, and nothing is held or checked', async () => {
    const { fakes, read } = deps();
    expect(await admitAsk(KEY, 'another-token', fakes)).toEqual({
      status: 'denied',
    });
    expect(read).toEqual(['standing', 'token']);
  });

  test('onToken runs once the token has matched, and not for a request refused before', async () => {
    let started = 0;
    await admitAsk(KEY, TOKEN, deps().fakes, () => started++);
    expect(started).toBe(1);
    await admitAsk(KEY, 'another-token', deps().fakes, () => started++);
    await admitAsk(KEY, TOKEN, deps({ standing: null }).fakes, () => started++);
    expect(started).toBe(1);
    // Started beside the checks that follow, a listed key's included.
    await admitAsk(KEY, TOKEN, deps({ listed: true }).fakes, () => started++);
    expect(started).toBe(2);
  });

  test('a listed key is denied before anything is held or checked, the owner’s too', async () => {
    for (const standing of ['public', 'local', 'owner'] as const) {
      const { fakes, read } = deps({ standing, listed: true });
      expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
      expect(read).toEqual(['standing', 'token', 'listed']);
    }
  });

  test('the owner is admitted without a budget and without the check, and charged nothing', async () => {
    const { fakes, read, settles } = deps({
      standing: 'owner',
      hold: every({ admitted: false, until: UNTIL.device }),
      verdict: 'automated',
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(2_000_000);
    expect(read).toEqual(['standing', 'token', 'listed']);
    expect(settles).toEqual([]);
  });

  test('the owner reads no budget, network or site and holds nothing, whatever they would say', async () => {
    const { fakes, read, holds } = deps({
      standing: 'owner',
      budgets: NONE,
      network: null,
    });
    expect((await admitAsk(KEY, TOKEN, fakes)).status).toBe('admitted');
    expect(read).not.toContain('budgets');
    expect(read).not.toContain('network');
    expect(read).not.toContain('site');
    expect(holds).toEqual([]);
  });

  test('a device whose asks have used up its budget is told when it may ask again, nothing else is held or settled, and the check is not asked', async () => {
    const { fakes, read, holds, settles } = deps({ hold: refusedAt('device') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.device,
    });
    expect(holds).toEqual(heldOn(['device']));
    expect(settles).toEqual([]);
    expect(read).not.toContain('verdict');
  });

  test('a network waiting out a cooldown gives the device’s hold back whole in its own window, holds nothing at the site, and tells the network’s time', async () => {
    const { fakes, read, holds, settles } = deps({
      hold: refusedAt('network'),
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.network,
    });
    expect(holds).toEqual(heldOn(['device', 'network']));
    expect(settles).toEqual(settledAt(0, ['device']));
    expect(read).not.toContain('verdict');
  });

  test('the site waiting out a cooldown gives back both earlier holds, each in its own window, and tells the site’s time', async () => {
    const { fakes, read, holds, settles } = deps({ hold: refusedAt('site') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.site,
    });
    expect(holds).toEqual(heldOn(['device', 'network', 'site']));
    expect(settles).toEqual(settledAt(0, ['device', 'network']));
    expect(read).not.toContain('verdict');
  });

  test('a hold given back that cannot be written is said, the rest are still given back, and the time is still told', async () => {
    const said = quiet();
    const { fakes, settles } = deps({
      hold: refusedAt('site'),
      settle: { device: new Error('network down') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.site,
    });
    expect(settles).toEqual(settledAt(0, ['network']));
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be settled:',
    );
  });

  test('a busy device is unavailable: nothing is given back, nothing else is held, the check is not asked, and nothing is said', async () => {
    const said = quiet();
    const { fakes, read, holds, settles } = deps({ hold: busyAt('device') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(holds).toEqual(heldOn(['device']));
    expect(settles).toEqual([]);
    expect(read).not.toContain('verdict');
    expect(said).not.toHaveBeenCalled();
  });

  test('a busy network gives the device’s hold back whole in its own window, holds nothing at the site, and is unavailable with no time told', async () => {
    const { fakes, read, holds, settles } = deps({ hold: busyAt('network') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(holds).toEqual(heldOn(['device', 'network']));
    expect(settles).toEqual(settledAt(0, ['device']));
    expect(read).not.toContain('verdict');
  });

  test('a busy site gives back both earlier holds, each in its own window, and is unavailable', async () => {
    const { fakes, read, holds, settles } = deps({ hold: busyAt('site') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(holds).toEqual(heldOn(['device', 'network', 'site']));
    expect(settles).toEqual(settledAt(0, ['device', 'network']));
    expect(read).not.toContain('verdict');
  });

  test('a busy total is never answered with a cooldown, even with a later total waiting', async () => {
    for (const [busy, waiting] of [
      ['device', 'network'],
      ['device', 'site'],
      ['network', 'site'],
    ] as const) {
      const { fakes, holds } = deps({
        hold: { ...busyAt(busy), ...refusedAt(waiting) },
      });
      const admission = await admitAsk(KEY, TOKEN, fakes);
      expect(admission).toEqual({ status: 'unavailable' });
      expect(holds.map(({ key }) => key)).not.toContain(KEYS[waiting]);
    }
  });

  test('a hold given back that cannot be written while answering busy is said, and the rest are still given back', async () => {
    const said = quiet();
    const { fakes, settles } = deps({
      hold: busyAt('site'),
      settle: { device: new Error('network down') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(settles).toEqual(settledAt(0, ['network']));
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be settled:',
    );
  });

  test('an ask whose hold cannot be written is unavailable, never answered unmetered', async () => {
    const said = quiet();
    const { fakes, read, holds } = deps({
      hold: { device: new Error('relation missing') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(holds).toEqual(heldOn(['device']));
    expect(read).not.toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[1])).toContain('relation missing');
  });

  test('a hold that cannot be written at the network gives the device’s hold back whole, holds nothing at the site, and is unavailable, said once', async () => {
    const said = quiet();
    const { fakes, read, holds, settles } = deps({
      hold: { network: new Error('relation missing') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(holds).toEqual(heldOn(['device', 'network']));
    expect(settles).toEqual(settledAt(0, ['device']));
    expect(read).not.toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be counted:',
    );
  });

  test('a hold that cannot be written at the site gives both earlier holds back whole and is unavailable, said once', async () => {
    const said = quiet();
    const { fakes, read, settles } = deps({
      hold: { site: new Error('relation missing') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(settles).toEqual(settledAt(0, ['device', 'network']));
    expect(read).not.toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be counted:',
    );
  });

  test('a hold or a read that fails never puts the device key in the log', async () => {
    // As the driver reports it: the statement and the values bound to it, the key among them.
    const failure = new Error(
      `Failed query: INSERT INTO ask_usage ...\nparams: ${KEY},200000,1000000`,
      { cause: new Error('relation "ask_usage" does not exist') },
    );
    const said = quiet();
    await admitAsk(KEY, TOKEN, deps({ hold: every(failure) }).fakes);
    await admitMint(
      KEY,
      deps({ cooling: every(failure), hold: every(failure) }).fakes,
    );
    const charged = await admitAsk(
      KEY,
      TOKEN,
      deps({ settle: every(failure) }).fakes,
    );
    if (charged.status === 'admitted') await charged.charge(1);
    // One hold tried; the mint's two waits read and its charge; three totals settled.
    expect(said).toHaveBeenCalledTimes(7);
    for (const call of said.mock.calls) {
      expect(call.join(' ')).not.toContain(KEY);
      expect(call.join(' ')).toContain('relation "ask_usage" does not exist');
    }
  });

  test('a client the check names automated is denied whatever is enforced elsewhere: the device and the network are charged the least, and the site’s hold is given back whole', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const) {
      const { fakes, settles } = deps({ verdict });
      expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
      expect(settles).toEqual([
        ...settledAt(LEAST, ['device', 'network']),
        ...settledAt(0, ['site']),
      ]);
    }
  });

  test('a turned-away client gives up its reserve on every total, the site’s given back whole', async () => {
    const least = minimumCharge(BIG_DEVICE);
    const { fakes, settles } = deps({
      budgets: { device: BIG_DEVICE },
      verdict: 'automated',
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(
      settles.map(({ key, charge, reserve }) => [key, charge, reserve]),
    ).toEqual([
      [KEY, least, least],
      [NETWORK, least, least],
      [SITE, 0, least],
    ]);
  });

  test('a turned-away client on a local run counted against the site alone gives its hold back and is charged nothing', async () => {
    const { fakes, holds, settles } = deps({
      standing: 'local',
      budgets: { device: null, network: null },
      verdict: 'automated',
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(holds.map(({ key }) => key)).toEqual([SITE]);
    expect(settles).toEqual(settledAt(0, ['site']));
  });

  test('a give-back to the site that cannot be written for a turned-away client is said, and the device and the network are still charged', async () => {
    const said = quiet();
    const { fakes, settles } = deps({
      verdict: 'automated',
      settle: { site: new Error('network down') },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(settles).toEqual(settledAt(LEAST, ['device', 'network']));
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be settled:',
    );
  });

  test('a check that could not run is unavailable, and every hold is given back whole', async () => {
    const { fakes, settles } = deps({ verdict: 'unchecked' });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(settles).toEqual(settledAt(0));
  });

  test('a public visitor is denied with any one budget unset, holds nothing, and the unset variable is named', async () => {
    const said = quiet();
    for (const [budgets, name] of [
      [{ device: null }, 'ASK_DAILY_TOKENS'],
      [{ network: null }, 'ASK_DAILY_TOKENS_NETWORK'],
      [{ site: null }, 'ASK_DAILY_TOKENS_SITE'],
    ] as const) {
      said.mockClear();
      const { fakes, read, holds } = deps({ budgets });
      expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
      expect(read).toEqual([
        'standing',
        'token',
        'listed',
        'budgets',
        'network',
        'site',
      ]);
      expect(holds).toEqual([]);
      expect(said).toHaveBeenCalledTimes(1);
      expect(said).toHaveBeenCalledWith(`[ask] ${name} not set`);
    }
  });

  test('a public visitor with two budgets unset is denied and both variables are named, in order', async () => {
    const said = quiet();
    const { fakes, holds } = deps({ budgets: { network: null, site: null } });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(holds).toEqual([]);
    expect(said).toHaveBeenCalledTimes(1);
    expect(said).toHaveBeenCalledWith(
      '[ask] ASK_DAILY_TOKENS_NETWORK, ASK_DAILY_TOKENS_SITE not set',
    );
  });

  test('a public visitor with no network to count the request under is denied, holds nothing, and it is said', async () => {
    const said = quiet();
    const { fakes, read, holds } = deps({ network: null });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(holds).toEqual([]);
    expect(read).not.toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(said).toHaveBeenCalledWith(
      '[ask] no network to count the request under: no address, or ENGAGE_TOKEN_SECRET not set',
    );
  });

  test('a local run may go without a budget: nothing is held or charged, the check still decides', async () => {
    const open = deps({ standing: 'local', budgets: NONE });
    const admission = await admitAsk(KEY, TOKEN, open.fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(145_000);
    expect(open.read).toEqual([
      'standing',
      'token',
      'listed',
      'budgets',
      'network',
      'site',
      'verdict',
    ]);
    expect(open.settles).toEqual([]);
    for (const [verdict, status] of [
      ['automated', 'denied'],
      ['unchecked', 'unavailable'],
    ] as const)
      expect(
        await admitAsk(
          KEY,
          TOKEN,
          deps({ standing: 'local', budgets: NONE, verdict }).fakes,
        ),
      ).toEqual({ status });
  });

  test('a local run with only some budgets set is counted against exactly those', async () => {
    for (const [budgets, totals] of [
      [{ device: null, network: null }, ['site']],
      [{ network: null, site: null }, ['device']],
      [{ network: null }, ['device', 'site']],
    ] as const) {
      const { fakes, holds, settles } = deps({ standing: 'local', budgets });
      const admission = await admitAsk(KEY, TOKEN, fakes);
      if (admission.status !== 'admitted') throw new Error('not admitted');
      await admission.charge(140_000);
      expect(holds).toEqual(heldOn(totals));
      expect(settles).toEqual(settledAt(140_000, totals));
    }
  });

  test('a local run with a network budget but no network to count it under is counted against the others, and not refused', async () => {
    const said = quiet();
    const { fakes, holds, settles } = deps({
      standing: 'local',
      network: null,
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(holds).toEqual(heldOn(['device', 'site']));
    expect(settles).toEqual(settledAt(140_000, ['device', 'site']));
    expect(said).not.toHaveBeenCalled();
  });

  test('a local run with a budget set is metered as a public visitor is', async () => {
    const { fakes, read } = deps({
      standing: 'local',
      hold: refusedAt('device'),
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.device,
    });
    expect(read).toContain('hold device');
  });
});

describe('admitMint', () => {
  test('a visitor’s mint reads the device’s and the site’s waits, then charges the network, then asks the check, and a token is issued', async () => {
    const { fakes, read } = deps();
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read).toEqual([
      'standing',
      'listed',
      'budgets',
      'network',
      'site',
      'cooling device',
      'cooling site',
      'hold network',
      'settle network',
      'verdict',
    ]);
  });

  test('a mint is charged a tenth of the least an ask costs, held and settled on the network alone, in the window its hold returned', async () => {
    expect(MINT).toBe(1_000);
    expect(MINT).not.toBe(LEAST);
    expect(MINT).not.toBe(HOLD_TOKENS);
    const opened = '2026-11-20 23:59:59.999999+00';
    const { fakes, holds, settles } = deps({
      hold: { network: { admitted: true, opened } },
    });
    await admitMint(KEY, fakes);
    expect(holds).toEqual([
      { key: NETWORK, budget: BUDGETS.network, reserve: MINT },
    ]);
    expect(settles).toEqual([
      { key: NETWORK, opened, charge: MINT, reserve: MINT },
    ]);
  });

  test('a request that may not ask is nobody, before anything else is read', async () => {
    const { fakes, read } = deps({ standing: null });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'nobody' });
    expect(read).toEqual(['standing']);
  });

  test('a listed key is refused, the owner’s too', async () => {
    for (const standing of ['public', 'local', 'owner'] as const) {
      const { fakes, read } = deps({ standing, listed: true });
      expect(await admitMint(KEY, fakes)).toEqual({ status: 'refused' });
      expect(read).toEqual(['standing', 'listed']);
    }
  });

  test('the owner is issued a token without a budget, a wait or a check, whatever they would say', async () => {
    const { fakes, read } = deps({
      standing: 'owner',
      budgets: NONE,
      network: null,
      cooling: every(UNTIL.device),
      verdict: 'automated',
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read).toEqual(['standing', 'listed']);
  });

  test('a device waiting out a cooldown is told when it ends before the network is charged, and the check is not asked', async () => {
    const { fakes, read, holds, settles } = deps({
      cooling: { device: UNTIL.device },
    });
    expect(await admitMint(KEY, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.device,
    });
    expect(read).toEqual([
      'standing',
      'listed',
      'budgets',
      'network',
      'site',
      'cooling device',
    ]);
    expect(holds).toEqual([]);
    expect(settles).toEqual([]);
  });

  test('a network waiting out a cooldown refuses the mint’s charge with its time, which the mint is told, and the check is not asked', async () => {
    const { fakes, read, holds, settles } = deps({
      hold: refusedAt('network'),
    });
    expect(await admitMint(KEY, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.network,
    });
    expect(holds.map(({ key }) => key)).toEqual([NETWORK]);
    expect(settles).toEqual([]);
    expect(read.slice(5)).toEqual([
      'cooling device',
      'cooling site',
      'hold network',
    ]);
  });

  test('the site waiting out a cooldown is told before the network is charged: nothing is held or settled, and the check is not asked', async () => {
    const { fakes, read, holds, settles } = deps({
      cooling: { site: UNTIL.site },
    });
    expect(await admitMint(KEY, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.site,
    });
    expect(read.slice(5)).toEqual(['cooling device', 'cooling site']);
    expect(holds).toEqual([]);
    expect(settles).toEqual([]);
  });

  test('with the site and the network both waiting, the site’s time is the one told, and the network is not charged', async () => {
    const { fakes, holds } = deps({
      cooling: { site: UNTIL.site },
      hold: refusedAt('network'),
    });
    expect(await admitMint(KEY, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL.site,
    });
    expect(holds).toEqual([]);
  });

  test('a busy network takes no charge: nothing is settled, and the mint goes on to the check and issues', async () => {
    const { fakes, read, settles } = deps({ hold: busyAt('network') });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(settles).toEqual([]);
    expect(read.slice(5)).toEqual([
      'cooling device',
      'cooling site',
      'hold network',
      'verdict',
    ]);
  });

  test('a charge whose hold cannot be written is said once, and the mint goes on and issues', async () => {
    const said = quiet();
    const { fakes, read, settles } = deps({
      hold: { network: new Error('relation missing') },
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(settles).toEqual([]);
    expect(read).toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be counted:',
    );
  });

  test('a charge whose settle cannot be written is said once, and the mint goes on and issues', async () => {
    const said = quiet();
    const { fakes, read } = deps({
      settle: { network: new Error('relation missing') },
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read.slice(5)).toEqual([
      'cooling device',
      'cooling site',
      'hold network',
      'settle network',
      'verdict',
    ]);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be counted:',
    );
  });

  test('a device’s or the site’s wait that cannot be read is said, and the next total is still handled', async () => {
    const said = quiet();
    const device = deps({ cooling: { device: new Error('relation missing') } });
    expect(await admitMint(KEY, device.fakes)).toEqual({ status: 'issue' });
    expect(device.settles.map(({ key }) => key)).toEqual([NETWORK]);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be read:',
    );
    said.mockClear();
    const site = deps({ cooling: { site: new Error('relation missing') } });
    expect(await admitMint(KEY, site.fakes)).toEqual({ status: 'issue' });
    expect(site.read.at(-1)).toBe('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[0])).toBe(
      '[ask] usage could not be read:',
    );
  });

  test('a wait that cannot be read is left for the ask’s own hold: the check decides the token', async () => {
    const said = quiet();
    const { fakes } = deps({ cooling: every(new Error('relation missing')) });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    // The device's and the site's: the network is charged, not read.
    expect(said).toHaveBeenCalledTimes(2);
    expect(
      await admitMint(
        KEY,
        deps({ cooling: every(new Error('down')), verdict: 'automated' }).fakes,
      ),
    ).toEqual({ status: 'refused' });
  });

  test('a client the check names automated is refused and its charge stands; a check that could not run still issues, and its charge stands', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const) {
      const { fakes, settles } = deps({ verdict });
      expect(await admitMint(KEY, fakes)).toEqual({ status: 'refused' });
      expect(settles.map(({ key, charge }) => [key, charge])).toEqual([
        [NETWORK, MINT],
      ]);
    }
    const { fakes, settles } = deps({ verdict: 'unchecked' });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(settles.map(({ key, charge }) => [key, charge])).toEqual([
      [NETWORK, MINT],
    ]);
  });

  test('the owner, a listed key, a request that may not ask, and a public visitor missing a budget or a network are charged nothing', async () => {
    quiet();
    for (const setup of [
      { standing: 'owner' },
      { listed: true },
      { standing: null },
      { budgets: { device: null } },
      { budgets: { network: null } },
      { budgets: { site: null } },
      { network: null },
    ] satisfies Setup[]) {
      const { fakes, holds, settles } = deps(setup);
      await admitMint(KEY, fakes);
      expect(holds).toEqual([]);
      expect(settles).toEqual([]);
    }
  });

  test('a local run with no budgets is charged nothing for a mint', async () => {
    const { fakes, holds, settles } = deps({
      standing: 'local',
      budgets: NONE,
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(holds).toEqual([]);
    expect(settles).toEqual([]);
  });

  test('a local run with a network budget and a network charges its mint on the first counted total’s least', async () => {
    const charge = mintCharge(minimumCharge(BUDGETS.network));
    expect(charge).toBe(2_000);
    const { fakes, settles } = deps({
      standing: 'local',
      budgets: { device: null },
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(settles).toEqual([
      { key: NETWORK, opened: OPENED.network, charge, reserve: charge },
    ]);
  });

  test('a local run with a network budget but no network charges nothing for a mint and is not refused', async () => {
    const said = quiet();
    const { fakes, holds, settles } = deps({
      standing: 'local',
      network: null,
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(holds).toEqual([]);
    expect(settles).toEqual([]);
    expect(said).not.toHaveBeenCalled();
  });

  test('a public visitor is refused without a budget set, and it is said; a local run goes without', async () => {
    const said = quiet();
    const closed = deps({ budgets: { device: null } });
    expect(await admitMint(KEY, closed.fakes)).toEqual({ status: 'refused' });
    expect(closed.read).toEqual([
      'standing',
      'listed',
      'budgets',
      'network',
      'site',
    ]);
    expect(said).toHaveBeenCalledWith('[ask] ASK_DAILY_TOKENS not set');
    const local = deps({ standing: 'local', budgets: NONE });
    expect(await admitMint(KEY, local.fakes)).toEqual({ status: 'issue' });
    expect(local.read).toEqual([
      'standing',
      'listed',
      'budgets',
      'network',
      'site',
      'verdict',
    ]);
  });

  test('a public visitor with any budget unset, or no network to count it under, is refused before any wait is read', async () => {
    quiet();
    for (const setup of [
      { budgets: { device: null } },
      { budgets: { network: null } },
      { budgets: { site: null } },
      { network: null },
    ] satisfies Setup[]) {
      const { fakes, read } = deps(setup);
      expect(await admitMint(KEY, fakes)).toEqual({ status: 'refused' });
      expect(read).toEqual([
        'standing',
        'listed',
        'budgets',
        'network',
        'site',
      ]);
    }
  });

  test('a local run’s mint reads the wait of exactly the totals it is counted against', async () => {
    const { fakes, read } = deps({
      standing: 'local',
      budgets: { network: null },
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read.slice(5)).toEqual([
      'cooling device',
      'cooling site',
      'verdict',
    ]);
  });
});
