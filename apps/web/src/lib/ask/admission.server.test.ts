import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { BrowserVerdict } from '../device/browser-check.server';
import type { AskStanding } from './access.server';
import { type AdmissionDeps, admitAsk, admitMint } from './admission.server';
import { type Held, minimumCharge } from './allowance.server';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const TOKEN = 'a-live-token';
const UNTIL = 1_800_000_000_000;
const BUDGET = 1_000_000;
const LEAST = minimumCharge(BUDGET);
// The start of a window, as the database says it.
const OPENED = '2026-11-21 14:05:00.123456+00';

type Setup = {
  standing?: AskStanding;
  listed?: boolean;
  budget?: number | null;
  cooling?: number | null | Error;
  hold?: Held | Error;
  settle?: Error;
  verdict?: BrowserVerdict | 'unchecked';
};

/** The steps as fakes, each recording that it was read, in order, what was settled and in which window. */
function deps(setup: Setup = {}) {
  const read: string[] = [];
  const settled: number[] = [];
  const windows: string[] = [];
  const {
    standing = 'public',
    listed = false,
    cooling = null,
    hold = { admitted: true, opened: OPENED },
    verdict = 'person',
  } = setup;
  const budget = 'budget' in setup ? setup.budget : BUDGET;
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
    budget: () => {
      read.push('budget');
      return budget ?? null;
    },
    cooling: async () => {
      read.push('cooling');
      if (cooling instanceof Error) throw cooling;
      return cooling;
    },
    hold: async () => {
      read.push('hold');
      if (hold instanceof Error) throw hold;
      return hold;
    },
    settle: async (_key, opened, charge) => {
      read.push('settle');
      if (setup.settle) throw setup.settle;
      settled.push(charge);
      windows.push(opened);
    },
    verdict: async () => {
      read.push('verdict');
      return verdict;
    },
  };
  return { fakes, read, settled, windows };
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
    const { fakes, read, settled } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    expect(admission.status).toBe('admitted');
    expect(read).toEqual([
      'standing',
      'token',
      'listed',
      'budget',
      'hold',
      'verdict',
    ]);
    expect(settled).toEqual([]);
  });

  test('an admitted ask is charged the tokens it used', async () => {
    const { fakes, settled } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(settled).toEqual([140_000]);
  });

  test('every settlement of an ask is made in the window its hold was set in', async () => {
    const hold: Held = { admitted: true, opened: '2026-11-20 09:00:00+00' };
    const charged = deps({ hold });
    const admission = await admitAsk(KEY, TOKEN, charged.fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(140_000);
    expect(charged.windows).toEqual([hold.opened]);
    // The hold given back whole, and the one a turned-away client is charged for.
    for (const verdict of ['unchecked', 'automated'] as const) {
      const { fakes, windows } = deps({ hold, verdict });
      await admitAsk(KEY, TOKEN, fakes);
      expect(windows).toEqual([hold.opened]);
    }
  });

  test('an ask that used little, or nothing, is charged the least an ask costs', async () => {
    for (const used of [0, 4_000, LEAST - 1]) {
      const { fakes, settled } = deps();
      const admission = await admitAsk(KEY, TOKEN, fakes);
      if (admission.status !== 'admitted') throw new Error('not admitted');
      await admission.charge(used);
      expect(settled).toEqual([LEAST]);
    }
  });

  test('an ask is charged once, however often its charge is called', async () => {
    const { fakes, settled } = deps();
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(50_000);
    await admission.charge(90_000);
    expect(settled).toEqual([50_000]);
  });

  test('a charge that cannot be written is said and never thrown: the answer already given stands', async () => {
    const said = quiet();
    const { fakes } = deps({ settle: new Error('network down') });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await expect(admission.charge(50_000)).resolves.toBeUndefined();
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
    const { fakes, read, settled } = deps({
      standing: 'owner',
      hold: { admitted: false, until: UNTIL },
      verdict: 'automated',
    });
    const admission = await admitAsk(KEY, TOKEN, fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(2_000_000);
    expect(read).toEqual(['standing', 'token', 'listed']);
    expect(settled).toEqual([]);
  });

  test('a device whose asks have used up its budget is told when it may ask again, and the check is not asked', async () => {
    const { fakes, read, settled } = deps({
      hold: { admitted: false, until: UNTIL },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL,
    });
    expect(read).not.toContain('verdict');
    expect(settled).toEqual([]);
  });

  test('an ask whose hold cannot be written is unavailable, never answered unmetered', async () => {
    const said = quiet();
    const { fakes, read } = deps({ hold: new Error('relation missing') });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(read).not.toContain('verdict');
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]?.[1])).toContain('relation missing');
  });

  test('a hold or a read that fails never puts the device key in the log', async () => {
    // As the driver reports it: the statement and the values bound to it, the key among them.
    const failure = new Error(
      `Failed query: INSERT INTO ask_usage ...\nparams: ${KEY},200000,1000000`,
      { cause: new Error('relation "ask_usage" does not exist') },
    );
    const said = quiet();
    await admitAsk(KEY, TOKEN, deps({ hold: failure }).fakes);
    await admitMint(KEY, deps({ cooling: failure }).fakes);
    const charged = await admitAsk(KEY, TOKEN, deps({ settle: failure }).fakes);
    if (charged.status === 'admitted') await charged.charge(1);
    expect(said).toHaveBeenCalledTimes(3);
    for (const call of said.mock.calls) {
      expect(call.join(' ')).not.toContain(KEY);
      expect(call.join(' ')).toContain('relation "ask_usage" does not exist');
    }
  });

  test('a client the check names automated is denied whatever is enforced elsewhere, and charged the least an ask costs', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const) {
      const { fakes, settled } = deps({ verdict });
      expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
      expect(settled).toEqual([LEAST]);
    }
  });

  test('a check that could not run is unavailable, and its hold is given back whole', async () => {
    const { fakes, settled } = deps({ verdict: 'unchecked' });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'unavailable',
    });
    expect(settled).toEqual([0]);
  });

  test('a public visitor is never admitted without a budget set, and it is said', async () => {
    const said = quiet();
    const { fakes, read } = deps({ budget: null });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({ status: 'denied' });
    expect(read).toEqual(['standing', 'token', 'listed', 'budget']);
    expect(said).toHaveBeenCalledWith('[ask] ASK_DAILY_TOKENS not set');
  });

  test('a local run may go without a budget: nothing is held or charged, the check still decides', async () => {
    const open = deps({ standing: 'local', budget: null });
    const admission = await admitAsk(KEY, TOKEN, open.fakes);
    if (admission.status !== 'admitted') throw new Error('not admitted');
    await admission.charge(145_000);
    expect(open.read).toEqual([
      'standing',
      'token',
      'listed',
      'budget',
      'verdict',
    ]);
    expect(open.settled).toEqual([]);
    for (const [verdict, status] of [
      ['automated', 'denied'],
      ['unchecked', 'unavailable'],
    ] as const)
      expect(
        await admitAsk(
          KEY,
          TOKEN,
          deps({ standing: 'local', budget: null, verdict }).fakes,
        ),
      ).toEqual({ status });
  });

  test('a local run with a budget set is metered as a public visitor is', async () => {
    const { fakes, read } = deps({
      standing: 'local',
      hold: { admitted: false, until: UNTIL },
    });
    expect(await admitAsk(KEY, TOKEN, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL,
    });
    expect(read).toContain('hold');
  });
});

describe('admitMint', () => {
  test('a visitor is issued a token once the lists, the wait and the check have passed, in that order', async () => {
    const { fakes, read } = deps();
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read).toEqual([
      'standing',
      'listed',
      'budget',
      'cooling',
      'verdict',
    ]);
  });

  test('a mint holds nothing against the budget and is charged nothing', async () => {
    const { fakes, read, settled } = deps();
    await admitMint(KEY, fakes);
    expect(read).not.toContain('hold');
    expect(read).not.toContain('settle');
    expect(settled).toEqual([]);
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

  test('the owner is issued a token without a wait or a check', async () => {
    const { fakes, read } = deps({
      standing: 'owner',
      cooling: UNTIL,
      verdict: 'automated',
    });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(read).toEqual(['standing', 'listed']);
  });

  test('a device waiting out a cooldown is told when it ends, before the check is asked', async () => {
    const { fakes, read } = deps({ cooling: UNTIL });
    expect(await admitMint(KEY, fakes)).toEqual({
      status: 'cooldown',
      until: UNTIL,
    });
    expect(read).not.toContain('verdict');
  });

  test('a wait that cannot be read is left for the ask’s own hold: the check decides the token', async () => {
    const said = quiet();
    const { fakes } = deps({ cooling: new Error('relation missing') });
    expect(await admitMint(KEY, fakes)).toEqual({ status: 'issue' });
    expect(said).toHaveBeenCalledTimes(1);
    expect(
      await admitMint(
        KEY,
        deps({ cooling: new Error('down'), verdict: 'automated' }).fakes,
      ),
    ).toEqual({ status: 'refused' });
  });

  test('a client the check names automated is refused whatever is enforced elsewhere; a check that could not run still issues', async () => {
    for (const verdict of ['automated', 'verified crawler'] as const)
      expect(await admitMint(KEY, deps({ verdict }).fakes)).toEqual({
        status: 'refused',
      });
    expect(await admitMint(KEY, deps({ verdict: 'unchecked' }).fakes)).toEqual({
      status: 'issue',
    });
  });

  test('a public visitor is refused without a budget set, and it is said; a local run goes without', async () => {
    const said = quiet();
    const closed = deps({ budget: null });
    expect(await admitMint(KEY, closed.fakes)).toEqual({ status: 'refused' });
    expect(closed.read).toEqual(['standing', 'listed', 'budget']);
    expect(said).toHaveBeenCalledWith('[ask] ASK_DAILY_TOKENS not set');
    const local = deps({ standing: 'local', budget: null });
    expect(await admitMint(KEY, local.fakes)).toEqual({ status: 'issue' });
    expect(local.read).toEqual(['standing', 'listed', 'budget', 'verdict']);
  });
});
