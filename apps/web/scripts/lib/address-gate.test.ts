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
  const logs: string[] = [];
  const gate = makeAddressGate({
    gapMs,
    ledger,
    log: (message) => logs.push(message),
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
    logs,
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
  made.gate.settle('first.example', [A], 443, 'answered');
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

  test('two walks woken together, one of them late for its turn: the late one takes a new turn, and they never go together', async () => {
    let clock = 0;
    const ledger = memoryLedger();
    const asleep: (() => void)[] = [];
    /** Wake every request now waiting. */
    const wake = () => {
      for (const resume of asleep.splice(0)) resume();
    };
    /** A walk on the shared ledger whose waits end only when the test wakes them. */
    const walk = () =>
      makeAddressGate({
        gapMs: 1000,
        ledger,
        now: () => clock,
        sleep: () => new Promise<void>((resolve) => asleep.push(resolve)),
      });
    const one = walk();
    const two = walk();
    await one.enter([A]);
    const sent: string[] = [];
    // Turns at 1000 and 2000.
    const first = one.enter([A]).then(() => sent.push(`one at ${clock}`));
    const second = two.enter([A]).then(() => sent.push(`two at ${clock}`));
    // The machine slept: both wake at 2000, the first a second late.
    clock = 2000;
    wake();
    await second;
    expect(sent).toEqual(['two at 2000']);
    clock = 3000;
    wake();
    await first;
    expect(sent).toEqual(['two at 2000', 'one at 3000']);
  });

  test('a request up to half a gap late still goes; any later and it takes a new turn', async () => {
    /** When the second of two requests is let through, having woken `late` ms after its turn. */
    const sentAt = async (late: number) => {
      let clock = 0;
      let oversleep = late;
      const gate = makeAddressGate({
        gapMs: 1000,
        ledger: memoryLedger(),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms + oversleep;
          oversleep = 0;
        },
      });
      await gate.enter([A]);
      await gate.enter([A]);
      return clock;
    };
    expect(await sentAt(0)).toBe(1000);
    expect(await sentAt(500)).toBe(1500);
    // Too late: it asks again, and is given the turn a gap after the one it missed.
    expect(await sentAt(501)).toBe(2000);
  });

  test('a ledger slower than the gap cannot hold a request for ever: late again after two new turns, it goes', async () => {
    let clock = 0;
    let reserved = 0;
    const gate = makeAddressGate({
      gapMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      ledger: {
        reserve: (_addresses, gapMs, now) => {
          reserved += 1;
          // A loop that never lets go ends the test here, not the test run.
          if (reserved > 20) throw new Error('still taking turns');
          // Every reservation takes a whole gap: its turn is past as it is handed back.
          clock += gapMs;
          return now;
        },
      },
    });
    expect(await gate.enter([A])).toBe(true);
    expect(reserved).toBe(3);
    expect(await gate.enter([A])).toBe(true);
    expect(reserved).toBe(6);
  });

  test('a request that wakes late twice running still takes a new turn each time', async () => {
    let clock = 0;
    let oversleeps = 2;
    const gate = makeAddressGate({
      gapMs: 1000,
      ledger: memoryLedger(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms + (oversleeps > 0 ? 600 : 0);
        oversleeps -= 1;
      },
    });
    await gate.enter([A]);
    // Turn at 1000, woken at 1600; a new one at 2000, woken at 2600; the third, at 3000, on time.
    await gate.enter([A]);
    expect(clock).toBe(3000);
  });
});

describe('makeAddressGate: an address that stops answering', () => {
  test('three different sites unanswered in a row, at an address that had been answering, pause it', async () => {
    expect(PAUSE_AFTER_SITES).toBe(3);
    const { gate } = answering();
    gate.settle('one.example', [A], 443, 'silent');
    gate.settle('two.example', [A], 443, 'silent');
    expect(gate.paused()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
    gate.settle('three.example', [A], 443, 'silent');
    expect(gate.paused()).toBe(1);
    expect(await gate.enter([A])).toBe(false);
  });

  test('the request that paused it, and each one kept back after, count as held', async () => {
    const { gate } = answering();
    gate.settle('one.example', [A], 443, 'silent');
    gate.settle('two.example', [A], 443, 'silent');
    expect(gate.heldRequests()).toBe(0);
    gate.settle('three.example', [A], 443, 'silent');
    expect(gate.heldRequests()).toBe(1);
    await gate.enter([A]);
    await gate.enter([A]);
    expect(gate.heldRequests()).toBe(3);
  });

  test('says so once as each address is paused, by count and never by address or site', async () => {
    const { gate, logs } = answering();
    gate.settle('first.example', [B], 443, 'answered');
    for (const host of ['one.example', 'two.example']) {
      gate.settle(host, [A], 443, 'silent');
      gate.settle(host, [B], 443, 'silent');
    }
    expect(logs).toEqual([]);
    gate.settle('three.example', [A], 443, 'silent');
    await gate.enter([A]);
    gate.settle('three.example', [B], 443, 'silent');
    await gate.enter([B]);
    const announced = [
      '  a hosting address stopped answering and is left alone for the rest of this run (1 so far)',
      '  a hosting address stopped answering and is left alone for the rest of this run (2 so far)',
    ];
    expect(logs).toEqual(announced);
    // Nothing reported afterwards pauses anything, so nothing more is said or counted.
    const held = gate.heldRequests();
    gate.settle('four.example', [A], 443, 'silent');
    gate.settle('four.example', [A, B], 443, 'answered');
    gate.settle('five.example', ['192.0.2.12'], 443, 'silent');
    expect(logs).toEqual(announced);
    expect(gate.heldRequests()).toBe(held);
  });

  test('an answer in between starts the count again', async () => {
    const { gate } = answering();
    gate.settle('one.example', [A], 443, 'silent');
    gate.settle('two.example', [A], 443, 'silent');
    gate.settle('three.example', [A], 443, 'answered');
    gate.settle('four.example', [A], 443, 'silent');
    gate.settle('five.example', [A], 443, 'silent');
    expect(gate.paused()).toBe(0);
    gate.settle('six.example', [A], 443, 'silent');
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
      gate.settle(host, [A], 443, 'silent');
    }
    expect(gate.paused()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
  });

  test('an address never heard from is a dead site, never paused', async () => {
    const { gate } = gateWith();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 443, 'silent');
    }
    expect(gate.paused()).toBe(0);
    expect(gate.heldRequests()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
  });

  test('a failure that is neither an answer nor silence changes nothing', async () => {
    const unheard = gateWith();
    unheard.gate.settle('zero.example', [A], 443, 'other');
    for (const host of ['one.example', 'two.example', 'three.example']) {
      unheard.gate.settle(host, [A], 443, 'silent');
    }
    // It never counted as an answer.
    expect(unheard.gate.paused()).toBe(0);

    const { gate } = answering();
    gate.settle('one.example', [A], 443, 'silent');
    gate.settle('two.example', [A], 443, 'silent');
    gate.settle('three.example', [A], 443, 'other');
    // Nor as silence, nor as an answer that starts the count again.
    expect(gate.paused()).toBe(0);
    gate.settle('four.example', [A], 443, 'silent');
    expect(gate.paused()).toBe(1);
  });

  test('each address counts for itself: a host on two is silent at both, paused only where it had answered', async () => {
    const { gate } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A, B], 443, 'silent');
    }
    expect(gate.paused()).toBe(1);
    expect(await gate.enter([B])).toBe(true);
    expect(await gate.enter([A])).toBe(false);
  });

  test('silence on a port the address was never heard on is a dead site too, never counted', async () => {
    const { gate } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 81, 'silent');
    }
    expect(gate.paused()).toBe(0);
    expect(gate.heldRequests()).toBe(0);
    expect(await gate.enter([A])).toBe(true);
  });

  test('each port counts for itself: an answer on one does not start the count again on another', async () => {
    const { gate } = answering();
    gate.settle('first.example', [A], 80, 'answered');
    gate.settle('one.example', [A], 443, 'silent');
    gate.settle('two.example', [A], 443, 'silent');
    gate.settle('three.example', [A], 80, 'silent');
    gate.settle('four.example', [A], 80, 'answered');
    expect(gate.paused()).toBe(0);
    gate.settle('five.example', [A], 443, 'silent');
    expect(gate.paused()).toBe(1);
  });

  test('paused on the port it stopped answering on, the address is left alone on every port', async () => {
    const { gate, logs } = answering();
    gate.settle('first.example', [A], 80, 'answered');
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 443, 'silent');
    }
    expect(await gate.enter([A])).toBe(false);
    // Nothing reported on its other port afterwards pauses it again, or says so.
    for (const host of ['four.example', 'five.example', 'six.example']) {
      gate.settle(host, [A], 80, 'silent');
    }
    expect(gate.paused()).toBe(1);
    expect(logs).toHaveLength(1);
  });

  test('a paused address holds every host that resolves to it, and takes no turn at the others', async () => {
    const { gate, waits } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 443, 'silent');
    }
    expect(await gate.enter([B, A])).toBe(false);
    expect(await gate.enter([B])).toBe(true);
    expect(waits).toEqual([]);
  });

  test('it stays paused for the rest of the run, whatever answers later', async () => {
    const { gate, pass } = answering();
    for (const host of ['one.example', 'two.example', 'three.example']) {
      gate.settle(host, [A], 443, 'silent');
    }
    gate.settle('four.example', [A], 443, 'answered');
    pass(3_600_000);
    expect(await gate.enter([A])).toBe(false);
    expect(gate.paused()).toBe(1);
  });

  test('a request waiting its turn when the address is paused is not sent', async () => {
    const during: { wait?: () => void } = {};
    const { gate } = gateWith(1000, memoryLedger(), during);
    gate.settle('first.example', [A], 443, 'answered');
    await gate.enter([A]);
    during.wait = () => {
      for (const host of ['one.example', 'two.example', 'three.example']) {
        gate.settle(host, [A], 443, 'silent');
      }
    };
    expect(await gate.enter([A])).toBe(false);
    expect(gate.heldRequests()).toBe(2);
  });
});
