/**
 * Pacing by hosting address. One address can serve many company sites, so a
 * walk is paced by the addresses a host resolves to rather than by the host:
 * every request waits its turn at each of them, and an address that stops
 * answering is left alone for the rest of the run.
 */

import type { Ledger } from './address-ledger.ts';

/** Least time between two requests to one address, from every walk sharing the ledger together. */
export const ADDRESS_GAP_MS = 1_000;

/** Different sites that must go unanswered in a row, at an address and port that had been answering, before the address is paused. */
export const PAUSE_AFTER_SITES = 3;

/** New turns a request takes for coming late to the one it had, before it goes on the turn it has. */
const LATE_RETAKES = 2;

/** What a request came to: any response at all, none in time, or a failure that says neither. */
export type Outcome = 'answered' | 'silent' | 'other';

export type AddressGate = {
  /** Wait a request's turn at each of its host's addresses; false when one is paused, and the request must not be sent. */
  enter(addresses: readonly string[]): Promise<boolean>;
  /** Report what a request sent after `enter` came to, at each address it went to and on the port it was asked on. */
  settle(
    host: string,
    addresses: readonly string[],
    port: number,
    outcome: Outcome,
  ): void;
  /** Requests a paused address has kept from being sent so far, the one that paused it included. */
  heldRequests(): number;
  /** Addresses paused so far. */
  paused(): number;
};

export type AddressGateOptions = {
  /** Least time between two requests to one address; 0 paces nothing. */
  gapMs: number;
  ledger: Ledger;
  /** Told when an address is paused: a count, never the address. */
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** A site as the pause counts it: its host, without a leading `www.`. */
function siteOf(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** An address on one port: what answers, and what goes unanswered. */
function serviceAt(address: string, port: number): string {
  return `${address} ${port}`;
}

/** A gate for one run: turns come from the ledger, pauses are this process's own. */
export function makeAddressGate(options: AddressGateOptions): AddressGate {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const answered = new Set<string>();
  const silent = new Map<string, Set<string>>();
  const pausedAt = new Set<string>();
  let held = 0;

  /** Whether any of a host's addresses is paused. */
  const anyPaused = (addresses: readonly string[]) =>
    addresses.some((address) => pausedAt.has(address));

  return {
    async enter(addresses) {
      if (anyPaused(addresses)) {
        held += 1;
        return false;
      }
      for (let retakes = 0; options.gapMs > 0; retakes++) {
        const turn = options.ledger.reserve(addresses, options.gapMs, now());
        const wait = turn - now();
        if (wait > 0) await sleep(wait);
        // Over half a gap late, it takes a new turn: the request after it may be going already.
        if (now() - turn <= options.gapMs / 2) break;
        // Late every time, the ledger is slower than the gap: it goes on the turn it has.
        if (retakes >= LATE_RETAKES) break;
      }
      // Paused while this request waited its turn.
      if (anyPaused(addresses)) {
        held += 1;
        return false;
      }
      return true;
    },
    settle(host, addresses, port, outcome) {
      if (outcome === 'other') return;
      let pausedNow = false;
      for (const address of addresses) {
        const service = serviceAt(address, port);
        if (outcome === 'answered') {
          answered.add(service);
          silent.delete(service);
          continue;
        }
        // An address never heard from there is a dead site's own, not one that stopped.
        if (!answered.has(service) || pausedAt.has(address)) continue;
        const sites = silent.get(service) ?? new Set<string>();
        sites.add(siteOf(host));
        silent.set(service, sites);
        if (sites.size >= PAUSE_AFTER_SITES) {
          pausedAt.add(address);
          silent.delete(service);
          pausedNow = true;
        }
      }
      if (!pausedNow) return;
      held += 1;
      options.log?.(
        `  a hosting address stopped answering and is left alone for the rest of this run (${pausedAt.size} so far)`,
      );
    },
    heldRequests: () => held,
    paused: () => pausedAt.size,
  };
}
