import { describe, expect, test } from 'bun:test';

import type { PickerCompany } from '../../src/lib/websites/fallback.ts';
import { isPickerAnswer, loadPicker } from './site-picker.ts';

const KEY = 'test-key-0123456789';
const MODULE = '/tmp/picker/site-pick.ts';

const COMPANY: PickerCompany = {
  number: '09990117',
  name: 'QUILLMERE FABRICATION LIMITED',
  sponsorNames: [],
  towns: [],
  locality: null,
  postcode: null,
  incorporated: null,
  trades: [],
};

/** A module whose pickSite answers the probe as the contract says, then `answer`. */
function moduleAnswering(answer: unknown) {
  const calls: { candidates: unknown[]; options: unknown }[] = [];
  const pickSite = async (
    _company: unknown,
    candidates: unknown[],
    options: unknown,
  ) => {
    calls.push({ candidates, options });
    return candidates.length === 0
      ? { pick: null, reason: 'no_candidates', tokens: 0 }
      : answer;
  };
  return { importModule: async () => ({ pickSite }), calls };
}

describe('loadPicker', () => {
  test('stops before any row without its module path or its key', async () => {
    const { importModule } = moduleAnswering(null);
    await expect(loadPicker(undefined, KEY, importModule)).rejects.toThrow(
      'PICKER_MODULE is not set',
    );
    await expect(loadPicker(MODULE, '', importModule)).rejects.toThrow(
      'PICKER_API_KEY is not set',
    );
  });

  test('stops when the module exports no pickSite', async () => {
    await expect(
      loadPicker(MODULE, KEY, async () => ({ other: () => null })),
    ).rejects.toThrow('exports no pickSite');
  });

  test('checks the contract with a probe that spends nothing, then passes the key on', async () => {
    const { importModule, calls } = moduleAnswering({
      pick: 'https://www.quillmerefabrication.co.uk',
      reason: 'picked',
      tokens: 2900,
    });
    const pick = await loadPicker(MODULE, KEY, importModule);
    expect(calls).toEqual([{ candidates: [], options: { apiKey: KEY } }]);
    const answer = await pick(COMPANY, [
      { origin: 'https://www.quillmerefabrication.co.uk', title: '', text: '' },
    ]);
    expect(answer.reason).toBe('picked');
    expect(calls[1].options).toEqual({ apiKey: KEY });
  });

  test('stops when the probe is answered outside the contract', async () => {
    const pickSite = async () => ({ pick: null, reason: 'picked', tokens: 0 });
    await expect(
      loadPicker(MODULE, KEY, async () => ({ pickSite })),
    ).rejects.toThrow('outside its contract');
  });

  test('throws on an answer outside the contract, rather than reading it', async () => {
    const { importModule } = moduleAnswering({ pick: 'x', reason: 'maybe' });
    const pick = await loadPicker(MODULE, KEY, importModule);
    await expect(
      pick(COMPANY, [{ origin: 'x', title: '', text: '' }]),
    ).rejects.toThrow('outside its contract');
  });
});

describe('isPickerAnswer', () => {
  test('a choice exactly when it says it picked', () => {
    expect(isPickerAnswer({ pick: 'x', reason: 'picked', tokens: 1 })).toBe(
      true,
    );
    expect(
      isPickerAnswer({ pick: null, reason: 'below_threshold', tokens: 1 }),
    ).toBe(true);
    expect(
      isPickerAnswer({ pick: 'x', reason: 'unavailable', tokens: 1 }),
    ).toBe(false);
    expect(isPickerAnswer({ pick: null, reason: 'picked', tokens: 1 })).toBe(
      false,
    );
    expect(
      isPickerAnswer({ pick: null, reason: 'unavailable', tokens: Number.NaN }),
    ).toBe(false);
    expect(isPickerAnswer(null)).toBe(false);
  });
});
