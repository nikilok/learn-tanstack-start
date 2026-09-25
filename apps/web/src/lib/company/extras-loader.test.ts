import { describe, expect, test } from 'bun:test';

import type { CompanyExtras } from './extras';
import {
  createExtrasLoader,
  type ExtrasPage,
  type ExtrasResponse,
} from './extras-loader';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const page = (slug: string): ExtrasPage => ({
  slug,
  slugIds: ['hash0000001'],
  companyNumber: '01111111',
});
const EXTRAS: CompanyExtras = {
  licenceNumbers: ['TESTLIC01'],
  website: 'https://acme.example',
};

type Server = {
  /** Tokens the server accepts; minting adds the new one. */
  valid: Set<string>;
  mints: number;
  loads: string[];
  /** Every page the server was asked about, as sent. */
  pages: ExtrasPage[];
  /** When set, the next mint fails with this error instead of issuing. */
  mintError: Error | null;
  /** When false, mints issue no token. */
  issuing: boolean;
  /** When true, every token is refused, fresh ones included. */
  refusing: boolean;
};

/** A loader over a fake server that issues `token-1`, `token-2`, … and accepts only tokens in `valid`. */
function boot() {
  const server: Server = {
    valid: new Set(),
    mints: 0,
    loads: [],
    pages: [],
    mintError: null,
    issuing: true,
    refusing: false,
  };
  const load = createExtrasLoader(
    async () => {
      if (server.mintError) {
        const error = server.mintError;
        server.mintError = null;
        throw error;
      }
      if (!server.issuing) return null;
      server.mints++;
      const token = `token-${server.mints}`;
      server.valid.add(token);
      return token;
    },
    async (asked, _key, token): Promise<ExtrasResponse> => {
      server.pages.push(asked);
      server.loads.push(token);
      return !server.refusing && server.valid.has(token)
        ? { status: 'ok', extras: EXTRAS }
        : { status: 'denied' };
    },
  );
  return { load, server };
}

describe('createExtrasLoader', () => {
  test('mints on the first load and reuses the token after', async () => {
    const { load, server } = boot();
    expect(await load(page('acme-ltd'), KEY)).toEqual(EXTRAS);
    expect(await load(page('other-ltd'), KEY)).toEqual(EXTRAS);
    expect(server.mints).toBe(1);
    expect(server.loads).toEqual(['token-1', 'token-1']);
  });

  test('asks for the page it was given, company included, on every attempt', async () => {
    const { load, server } = boot();
    await load(page('acme-ltd'), KEY);
    server.valid.clear();
    await load(page('acme-ltd'), KEY);
    expect(server.pages).toEqual([
      page('acme-ltd'),
      page('acme-ltd'),
      page('acme-ltd'),
    ]);
  });

  test('concurrent first loads share one mint', async () => {
    const { load, server } = boot();
    await Promise.all([load(page('a-ltd'), KEY), load(page('b-ltd'), KEY)]);
    expect(server.mints).toBe(1);
  });

  test('a refused token is replaced once and the load retried', async () => {
    const { load, server } = boot();
    await load(page('acme-ltd'), KEY);
    server.valid.clear(); // token-1 has expired
    expect(await load(page('acme-ltd'), KEY)).toEqual(EXTRAS);
    expect(server.mints).toBe(2);
    expect(server.loads).toEqual(['token-1', 'token-1', 'token-2']);
  });

  test('two loads refused with the same token replace it only once', async () => {
    const { load, server } = boot();
    await load(page('acme-ltd'), KEY);
    server.valid.clear();
    await Promise.all([load(page('a-ltd'), KEY), load(page('b-ltd'), KEY)]);
    expect(server.mints).toBe(2);
  });

  test('a second refusal gives up with null', async () => {
    const { load, server } = boot();
    await load(page('acme-ltd'), KEY);
    server.refusing = true;
    expect(await load(page('acme-ltd'), KEY)).toBeNull();
    expect(server.loads).toEqual(['token-1', 'token-1', 'token-2']);
  });

  test('a mint that issues no token resolves null without loading', async () => {
    const { load, server } = boot();
    server.issuing = false;
    expect(await load(page('acme-ltd'), KEY)).toBeNull();
    expect(server.loads).toEqual([]);
  });

  test('a failed mint rejects that load and the next load mints again', async () => {
    const { load, server } = boot();
    server.mintError = new Error('network');
    await expect(load(page('acme-ltd'), KEY)).rejects.toThrow('network');
    expect(await load(page('acme-ltd'), KEY)).toEqual(EXTRAS);
    expect(server.mints).toBe(1);
  });
});
