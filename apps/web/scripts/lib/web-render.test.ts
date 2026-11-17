import { afterEach, describe, expect, test } from 'bun:test';

import type { Browser, BrowserContext, Page } from 'playwright';

import type { AddressGate } from './address-gate.ts';
import {
  checkFetchable,
  clearRobotsCache,
  configureFetch,
  USER_AGENT,
} from './web-fetch.ts';
import { renderIn, requestVerdict, visitIn } from './web-render.ts';

describe('requestVerdict', () => {
  test("a page's document, scripts and data calls load", () => {
    expect(requestVerdict('https://qmx.co.uk/', 'document')).toBe('continue');
    expect(requestVerdict('https://qmx.co.uk/app.js', 'script')).toBe(
      'continue',
    );
    expect(requestVerdict('http://api.qmx.co.uk/team', 'fetch')).toBe(
      'continue',
    );
  });

  test('images, media, fonts and stylesheets never load', () => {
    for (const type of ['image', 'media', 'font', 'stylesheet']) {
      expect(requestVerdict('https://qmx.co.uk/asset', type)).toBe('abort');
    }
  });

  test('in-page data stays in the browser; any other scheme is refused', () => {
    expect(requestVerdict('data:text/plain,hi', 'fetch')).toBe('continue');
    expect(requestVerdict('blob:https://qmx.co.uk/1f2e', 'fetch')).toBe(
      'continue',
    );
    expect(requestVerdict('file:///etc/hosts', 'document')).toBe('abort');
    expect(requestVerdict('ftp://qmx.co.uk/', 'document')).toBe('abort');
  });
});

// Documentation addresses and reserved names: nobody's.
const HOSTS: Record<string, string> = {
  'site.example': '192.0.2.10',
  'elsewhere.example': '192.0.2.20',
  'inside.example': '10.0.0.8',
};
const PAGE = 'https://site.example/team';
const HTML = '<html><body>rendered</body></html>';

/** Resolves after ms of real time: the render's own time limits run on real timers. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise settled from outside, for a browser step a test holds back. */
function held<T>(): { promise: Promise<T>; release(value: T): void } {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A gate recording each turn asked for: granted after `waitMs`, or refused as a paused address is. */
function gateOf(
  events: string[],
  { waitMs = 0, paused = false }: { waitMs?: number; paused?: boolean } = {},
): AddressGate {
  return {
    enter: async (addresses) => {
      events.push(`turn ${addresses.join(',')}`);
      if (waitMs > 0) await sleep(waitMs);
      return !paused;
    },
    settle: () => {},
    heldRequests: () => 0,
    paused: () => 0,
  };
}

/** A browser page recording what is asked of it: it answers `status` after `gotoMs` and lands on `landed`. */
function pageOf(
  events: string[],
  {
    status = 200,
    gotoMs = 0,
    landed,
  }: { status?: number; gotoMs?: number; landed?: string } = {},
): Page {
  let at = 'about:blank';
  const page = {
    goto: async (url: string) => {
      events.push(`goto ${url}`);
      if (gotoMs > 0) await sleep(gotoMs);
      at = landed ?? url;
      return { status: () => status };
    },
    waitForLoadState: async () => {},
    url: () => at,
    content: async () => HTML,
    close: async () => {
      events.push('page closed');
    },
  };
  return page as unknown as Page;
}

/** A browser context whose every new page is `page`, made after `makeMs`. */
function contextOf(
  events: string[],
  page: Page | Promise<Page>,
  makeMs = 0,
): BrowserContext {
  const context = {
    route: async () => {
      events.push('requests routed');
    },
    newPage: async () => {
      events.push('page asked for');
      if (makeMs > 0) await sleep(makeMs);
      return page;
    },
    close: async () => {
      events.push('context closed');
    },
  };
  return context as unknown as BrowserContext;
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  clearRobotsCache();
});

/**
 * The fetcher's guards on a fake network, `gate` installed once the page's
 * robots.txt is read: the only turns a test then sees are its pages'.
 */
async function network(gate: AddressGate): Promise<void> {
  restore?.();
  clearRobotsCache();
  // The first undo puts back what was there before both changes.
  restore = configureFetch({
    lookup: async (hostname) => {
      const address = HOSTS[hostname];
      if (!address) throw new Error(`ENOTFOUND ${hostname}`);
      return [{ address }];
    },
    fetch: async () => new Response('', { status: 404 }),
    gate: null,
  });
  await checkFetchable(PAGE);
  configureFetch({ gate });
}

describe('renderIn', () => {
  test('a page takes its turn once it is made, and goes on that turn', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const made = held<Page>();
    const rendering = renderIn(contextOf(events, made.promise), PAGE);
    // However long the browser takes over the page, no turn is spent waiting for it.
    await sleep(20);
    expect(events).toEqual(['page asked for']);

    made.release(pageOf(events));
    expect(await rendering).toEqual({
      ok: true,
      url: PAGE,
      status: 200,
      html: HTML,
      attempts: 1,
      attemptedUrl: PAGE,
    });
    expect(events).toEqual([
      'page asked for',
      'turn 192.0.2.10',
      `goto ${PAGE}`,
      'page closed',
    ]);
  });

  test('a page held back at a paused address is closed without going anywhere', async () => {
    const events: string[] = [];
    await network(gateOf(events, { paused: true }));
    const result = await renderIn(contextOf(events, pageOf(events)), PAGE);

    expect(result).toEqual({
      ok: false,
      reason: 'address_paused',
      attempts: 1,
      attemptedUrl: PAGE,
    });
    expect(events).toEqual([
      'page asked for',
      'turn 192.0.2.10',
      'page closed',
    ]);
  });

  test('the wait for its turn is no part of its time limit', async () => {
    const events: string[] = [];
    await network(gateOf(events, { waitMs: 260 }));
    const result = await renderIn(
      contextOf(events, pageOf(events, { gotoMs: 20 })),
      PAGE,
      200,
    );

    expect(result.ok).toBe(true);
  });

  test('the time the browser took to make the page comes off its limit', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const result = await renderIn(
      contextOf(events, pageOf(events, { gotoMs: 200 }), 150),
      PAGE,
      250,
    );

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(events).toContain('page closed');
  });

  test('a page the browser cannot make in time is a timeout, and takes no turn', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const never = new Promise<Page>(() => {});
    const result = await renderIn(contextOf(events, never), PAGE, 30);

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(events).toEqual(['page asked for']);
  }, 2_000);

  test('an error status is the failure, with the status', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const result = await renderIn(
      contextOf(events, pageOf(events, { status: 503 })),
      PAGE,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'http_error',
      status: 503,
      attempts: 1,
      attemptedUrl: PAGE,
    });
    expect(events.at(-1)).toBe('page closed');
  });

  test('the page it landed on has to pass the guards too', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const result = await renderIn(
      contextOf(
        events,
        pageOf(events, { landed: 'https://inside.example/admin' }),
      ),
      PAGE,
    );

    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
    expect(events.at(-1)).toBe('page closed');
  });

  test('a turn the landed page waits for, to have its robots.txt read, is no part of the time limit', async () => {
    const events: string[] = [];
    let turns = 0;
    // The page's own turn comes at once; the one for robots.txt where it landed takes longer than the limit.
    const gate: AddressGate = {
      ...gateOf(events),
      enter: async (addresses) => {
        events.push(`turn ${addresses.join(',')}`);
        turns += 1;
        if (turns > 1) await sleep(260);
        return true;
      },
    };
    await network(gate);
    const landed = 'https://elsewhere.example/home';
    const result = await renderIn(
      contextOf(events, pageOf(events, { gotoMs: 20, landed })),
      PAGE,
      200,
    );

    expect(result).toMatchObject({ ok: true, url: landed });
    expect(events).toEqual([
      'page asked for',
      'turn 192.0.2.10',
      `goto ${PAGE}`,
      'turn 192.0.2.20',
      'page closed',
    ]);
  });
});

describe('visitIn', () => {
  /** A browser whose contexts are `context`, handed over when the test releases it. */
  function browserOf(events: string[], context: Promise<BrowserContext>) {
    const options: unknown[] = [];
    const browser = {
      newContext: async (asked: unknown) => {
        events.push('context asked for');
        options.push(asked);
        return context;
      },
    };
    return {
      running: async () => browser as unknown as Pick<Browser, 'newContext'>,
      options,
    };
  }

  test('a page takes its turn after the browser has set up for it, however long that took', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const context = held<BrowserContext>();
    const { running, options } = browserOf(events, context.promise);
    const rendering = visitIn(running).render(PAGE);
    await sleep(20);
    expect(events).toEqual(['context asked for']);

    context.release(contextOf(events, pageOf(events)));
    expect((await rendering).ok).toBe(true);
    expect(events).toEqual([
      'context asked for',
      'requests routed',
      'page asked for',
      'turn 192.0.2.10',
      `goto ${PAGE}`,
      'page closed',
    ]);
    expect(options).toEqual([
      {
        userAgent: USER_AGENT,
        serviceWorkers: 'block',
        acceptDownloads: false,
      },
    ]);
  });

  test('a page the guards refuse opens nothing in the browser', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const { running } = browserOf(
      events,
      Promise.resolve(contextOf(events, pageOf(events))),
    );
    const result = await visitIn(running).render('https://inside.example/');

    expect(result).toMatchObject({ ok: false, reason: 'private_address' });
    expect(events).toEqual([]);
  });

  test('the pages of a visit share one context, closed with the visit', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const { running } = browserOf(
      events,
      Promise.resolve(contextOf(events, pageOf(events))),
    );
    const visit = visitIn(running);
    await visit.render(PAGE);
    await visit.render(PAGE);
    await visit.close();

    expect(events.filter((event) => event === 'context asked for')).toEqual([
      'context asked for',
    ]);
    expect(events.filter((event) => event.startsWith('turn'))).toHaveLength(2);
    expect(events.at(-1)).toBe('context closed');
  });

  test('a visit that rendered nothing has nothing to close', async () => {
    const events: string[] = [];
    await network(gateOf(events));
    const { running } = browserOf(
      events,
      Promise.resolve(contextOf(events, pageOf(events))),
    );
    await visitIn(running).close();

    expect(events).toEqual([]);
  });
});
