import { describe, expect, test } from 'bun:test';

import {
  ADDRESS_GAP_MS,
  makeAddressGate,
  PAUSE_AFTER_SITES,
} from './address-gate.ts';
import { type Ledger, memoryLedger } from './address-ledger.ts';

// Documentation addresses and reserved names: nobody's.
const A = '192.0.2.10';
const B = '192.0.2.11';

/** A gate on a fake clock, recording every wait; `during` runs inside each wait. */
function gateWith(
  gapMs = 1000,
  ledger: Ledger = memoryLedger(),
  during: { wait?: () => void } = {},
) {
  let clock = 0;
  const waits: number[] = [];
  const gate = makeAddressGate({
    gapMs,
    ledger,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
      during.wait?.();
    },
  });
  return {
    gate,
    waits,
    at: () => clock,
    /** Time passing between requests. */
    pass: (ms: number) => {
      clock += ms;
    },
  };
}

/** An address that has answered once, so it can be told apart from a dead one. */
function answering(gapMs = 1000) {
  const made = gateWith(gapMs);
  made.gate.settle('first.example', [A], 'answered');
  return made;
}

describe('makeAddressGate: turns', () => {
  test('one request a second to an address, by default', () => {
    expect(ADDRESS_GAP_MS).toBe(1000);
  });

  test('the first request to an address goes at once; the next waits out the gap', async () => {
    const { gate, waits, at, pass } = gateWith();
    expect(await gate.enter([A])).toBe(true);
    expect(waits).toEqual([]);
    expect(await gate.enter([A])).toBe(true);
    expect(at()).toBe(1000);
    pass(400);
    expect(await gate.enter([A])).toBe(true);
    expect(waits).toEqual([1000, 600]);
    expect(at()).toBe(2000);
  });

  test('time already spent counts toward the gap', async () => {
    const { gate, waits, pass } = gateWith();
    await gate.enter([A]);
    pass(1500);
    await gate.enter([A]);
    expect(waits).toEqual([]);
  });

  test('sites behind one address share its turns; another address is not kept waiting', async () => {
    const { gate, waits } = gateWith();
    await gate.enter([A]);
    await gate.enter([B]);
    expect(waits).toEqual([]);
    await gate.enter([A]);
    expect(waits).toEqual([1000]);
  });

  test('a host on two addresses takes its turn at both', async () => {
    const { gate, waits } = gateWith();
    await gate.enter([A, B]);
    await gate.enter([B]);
    expect(waits).toEqual([1000]);
  });

  test('a gap of 0 paces nothing, and asks the ledger for nothing', async () => {
    const { gate, waits } = gateWith(0, {
      reserve: () => {
        throw new Error('the ledger was asked');
      },
    });
    expect(await gate.enter([A])).toBe(true);
    expect(await gate.enter([A])).toBe(true);
    expect(waits).toEqual([]);
  });
});

describe('makeAddressGate: an address that stops answering', () => {
  test('three different sites unanswered in a row, at an address that had been answering, pause it', async () => {
    expect(PAUSE_AFTER_SITES).toBe(3);
    const { gate } = answering();
    gate.settle('one.example', [A], 'silent');
    gate.settle('two.example', [A], 'silent');
    expect(gate.paused()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
    gate.settle('three.example', [A], 'silent');
    expect(gate.paused()).toBe(1);
    expect(await gate.enter([A])).toBe(false);
  });

  test('the request that paused it, and each one kept back after, count as held', async () => {
    const { gate } = answering();
    gate.settle('one.example', [A], 'silent');
    gate.settle('two.example', [A], 'silent');
    expect(gate.heldRequests()).toBe(0);
    gate.settle('three.example', [A], 'silent');
    expect(gate.heldRequests()).toBe(1);
    await gate.enter([A]);
    await gate.enter([A]);
    expect(gate.heldRequests()).toBe(3);
  });

  test('an answer in between starts the count again', async () => {
    const { gate } = answering();
    gate.settle('one.example', [A], 'silent');
    gate.settle('two.example', [A], 'silent');
    gate.settle('three.example', [A], 'answered');
    gate.settle('four.example', [A], 'silent');
    gate.settle('five.example', [A], 'silent');
    expect(gate.paused()).toBe(0);
    gate.settle('six.example', [A], 'silent');
    expect(gate.paused()).toBe(1);
  });

  test('one site failing however often is its own trouble: its www and bare hosts are one site', async () => {
    const { gate } = answering();
    for (const host of [
      'one.example',
      'www.one.example',
      'WWW.ONE.EXAMPLE',
      'one.example',
      'two.example',
      'www.two.example',
    ]) {
      gate.settle(host, [A], 'silent');
    }
    expect(gate.paused()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
  });

  test('an address never heard from is a dead site, never paused', async () => {
    const { gate } = gateWith();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 'silent');
    }
    expect(gate.paused()).toBe(0);
    expect(gate.heldRequests()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
  });

  test('a failure that is neither an answer nor silence changes nothing', async () => {
    const unheard = gateWith();
    unheard.gate.settle('zero.example', [A], 'other');
    for (const host of ['one.example', 'two.example', 'three.example']) {
      unheard.gate.settle(host, [A], 'silent');
    }
    // It never counted as an answer.
    expect(unheard.gate.paused()).toBe(0);

    const { gate } = answering();
    gate.settle('one.example', [A], 'silent');
    gate.settle('two.example', [A], 'silent');
    gate.settle('three.example', [A], 'other');
    // Nor as silence, nor as an answer that starts the count again.
    expect(gate.paused()).toBe(0);
    gate.settle('four.example', [A], 'silent');
    expect(gate.paused()).toBe(1);
  });

  test('each address counts for itself: a host on two is silent at both, paused only where it had answered', async () => {
    const { gate } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A, B], 'silent');
    }
    expect(gate.paused()).toBe(1);
    expect(await gate.enter([B])).toBe(true);
    expect(await gate.enter([A])).toBe(false);
  });

  test('a paused address holds every host that resolves to it, and takes no turn at the others', async () => {
    const { gate, waits } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 'silent');
    }
    expect(await gate.enter([B, A])).toBe(false);
    expect(await gate.enter([B])).toBe(true);
    expect(waits).toEqual([]);
  });

  test('it stays paused for the rest of the run, whatever answers later', async () => {
    const { gate, pass } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 'silent');
    }
    gate.settle('four.example', [A], 'answered');
    pass(3_600_000);
    expect(await gate.enter([A])).toBe(false);
    expect(gate.paused()).toBe(1);
  });

  test('a request waiting its turn when the address is paused is not sent', async () => {
    const during: { wait?: () => void } = {};
    const { gate } = gateWith(1000, memoryLedger(), during);
    gate.settle('first.example', [A], 'answered');
    await gate.enter([A]);
    during.wait = () => {
      for (const host of ['one.example', 'two.example', 'three.example']) {
        gate.settle(host, [A], 'silent');
      }
    };
    expect(await gate.enter([A])).toBe(false);
    expect(gate.heldRequests()).toBe(2);
  });
});
