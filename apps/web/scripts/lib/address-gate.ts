/**
 * Pacing by hosting address. One address can serve many company sites, so a
 * walk is paced by the addresses a host resolves to rather than by the host:
 * every request waits its turn at each of them, and an address that stops
 * answering is left alone for the rest of the run.
 */

import type { Ledger } from './address-ledger.ts';

/** Least time between two requests to one address, from every walk sharing the ledger together. */
export const ADDRESS_GAP_MS = 1_000;

/** Different sites that must go unanswered in a row, at an address that had been answering, before it is paused. */
export const PAUSE_AFTER_SITES = 3;

/** What a request came to: any response at all, none in time, or a failure that says neither. */
export type Outcome = 'answered' | 'silent' | 'other';

export type AddressGate = {
  /** Wait a request's turn at each of its host's addresses; false when one is paused, and the request must not be sent. */
  enter(addresses: readonly string[]): Promise<boolean>;
  /** Report what a request sent after `enter` came to. */
  settle(host: string, addresses: readonly string[], outcome: Outcome): void;
  /** Requests a paused address has kept from being sent so far, the one that paused it included. */
  heldRequests(): number;
  /** Addresses paused so far. */
  paused(): number;
};

export type AddressGateOptions = {
  /** Least time between two requests to one address; 0 paces nothing. */
  gapMs: number;
  ledger: Ledger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** A site as the pause counts it: its host, without a leading `www.`. */
function siteOf(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
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
      if (options.gapMs > 0) {
        const turn = options.ledger.reserve(addresses, options.gapMs, now());
        const wait = turn - now();
        if (wait > 0) await sleep(wait);
      }
      // Paused while this request waited its turn.
      if (anyPaused(addresses)) {
        held += 1;
        return false;
      }
      return true;
    },
    settle(host, addresses, outcome) {
      if (outcome === 'other') return;
      let pausedNow = false;
      for (const address of addresses) {
        if (outcome === 'answered') {
          answered.add(address);
          silent.delete(address);
          continue;
        }
        // An address never heard from is a dead site's own, not one that stopped.
        if (!answered.has(address) || pausedAt.has(address)) continue;
        const sites = silent.get(address) ?? new Set<string>();
        sites.add(siteOf(host));
        silent.set(address, sites);
        if (sites.size >= PAUSE_AFTER_SITES) {
          pausedAt.add(address);
          silent.delete(address);
          pausedNow = true;
        }
      }
      if (pausedNow) held += 1;
    },
    heldRequests: () => held,
    paused: () => pausedAt.size,
  };
}
