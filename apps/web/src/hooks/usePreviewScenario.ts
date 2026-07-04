import { type RefObject, useEffect, useState } from 'react';

// Title of the home document; also the pill's resting label (mirrors APP_NAME).
const HOME_TITLE = 'Skilled Worker Sponsor Search';

export type PreviewStage =
  | 'loading'
  | 'home'
  | 'typing'
  | 'results'
  | 'details';

/** What the scene camera should look at: an app-content rect (iframe-viewport coords) or the whole scene (`rect: null`). */
export interface PreviewShot {
  rect: { left: number; top: number; width: number; height: number } | null;
  /** Breathing room around the rect, in iframe px. */
  padX?: number;
  padY?: number;
  /** Cap on the scene zoom multiple. */
  maxZ?: number;
  /** Transition length of this camera move. */
  ms: number;
}

/** Plain-object copy of a DOMRect (keeps the shot serialisable across the iframe realm). */
const toRect = (r: DOMRect) => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

/** Strips the SEO site-name suffixes so the pill shows just the page name (mirrors the shell's cleanTitle). */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|—–-]\s*SponsorSearch(\.co\.uk)?\s*$/i, '')
    .replace(/\s*-\s*UK Visa Sponsor\s*$/i, '')
    .trim();
}

/** Abortable delay — rejects when the scenario tears down mid-sleep. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Polls `get` until it returns a value or the timeout lapses (→ null); throws on abort. */
async function poll<T>(
  get: () => T | null | undefined,
  {
    intervalMs,
    timeoutMs,
    signal,
  }: { intervalMs: number; timeoutMs: number; signal: AbortSignal },
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs, signal);
  }
}

/** Sets the input's value through its own realm's native setter so React's change tracker registers the input event. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const win = input.ownerDocument.defaultView;
  if (!win) return;
  const setter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

/** Fires a plain left-click that TanStack Router's `<Link>` intercepts for SPA navigation. */
function clickLink(el: HTMLElement): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  el.dispatchEvent(
    new win.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: win,
      button: 0,
      detail: 1,
    }),
  );
}

/**
 * Drives the /download live preview like a user: waits for the iframed app to
 * hydrate, types the company name into the search box, lets the real results
 * stream in, then clicks the matching card through to its details page.
 * Returns the stage plus the title/back state the fake title bar mirrors.
 */
export function usePreviewScenario(
  frameRef: RefObject<HTMLIFrameElement | null>,
  paneRef: RefObject<HTMLElement | null>,
  company: string,
) {
  const [stage, setStage] = useState<PreviewStage>('loading');
  const [title, setTitle] = useState(HOME_TITLE);
  const [shot, setShot] = useState<PreviewShot>({ rect: null, ms: 0 });

  useEffect(() => {
    const maybeFrame = frameRef.current;
    const maybePane = paneRef.current;
    if (!maybeFrame || !maybePane) return;
    // Re-bind post-guard so the narrowed types survive into the closures below.
    const frame = maybeFrame;
    const pane = maybePane;
    const controller = new AbortController();
    const { signal } = controller;

    /** The iframe's same-origin document (null before load). */
    const doc = () => {
      try {
        return frame.contentDocument;
      } catch {
        return null;
      }
    };

    /** Best result card for `company`: exact name, then prefix, then substring, then the top hit. */
    const findCard = () => {
      const d = doc();
      if (!d) return null;
      const anchors = [
        ...d.querySelectorAll<HTMLAnchorElement>('a[href^="/company/"]'),
      ];
      if (anchors.length === 0) return null;
      const name = (a: HTMLAnchorElement) =>
        a.querySelector('h3')?.textContent?.trim().toLowerCase() ?? '';
      const wanted = company.trim().toLowerCase();
      // Shortest match ≈ the bare brand ("Checkout Ltd", not "Checkout
      // (Wimbledon) Limited"); sort is stable so ties keep result rank.
      const shortest = (matches: HTMLAnchorElement[]) =>
        matches
          .slice()
          .sort((a, b) => name(a).length - name(b).length)
          .at(0);
      return (
        anchors.find((a) => name(a) === wanted) ??
        shortest(anchors.filter((a) => name(a).startsWith(wanted))) ??
        shortest(anchors.filter((a) => name(a).includes(wanted))) ??
        anchors[0]
      );
    };

    async function run(): Promise<void> {
      // Hold the demo until the card is actually on screen.
      await new Promise<void>((resolve) => {
        const io = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              io.disconnect();
              resolve();
            }
          },
          { threshold: 0.2 },
        );
        io.observe(pane);
        signal.addEventListener('abort', () => io.disconnect(), {
          once: true,
        });
      });
      if (signal.aborted) return;

      // Reduced motion: skip the animated tour, land on the results view directly.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        frame.contentWindow?.location.replace(
          `/?search=${encodeURIComponent(company)}`,
        );
        setStage('results');
        return;
      }

      // Hydrated when React has claimed the input (props expando) — events
      // dispatched before that would fall on a listener-less document.
      const input = await poll(
        () => {
          const el = doc()?.querySelector<HTMLInputElement>(
            '.search-input-wrapper input',
          );
          return el &&
            Object.keys(el).some((k) => k.startsWith('__reactProps$'))
            ? el
            : null;
        },
        { intervalMs: 200, timeoutMs: 30_000, signal },
      );
      if (!input) return;

      setStage('home');
      await sleep(900, signal);

      // Camera: move in close on the search field so the typing reads clearly.
      setShot({
        rect: toRect(input.getBoundingClientRect()),
        padX: 48,
        padY: 90,
        maxZ: 2.2,
        ms: 900,
      });
      await sleep(950, signal);

      setStage('typing');
      for (let i = 1; i <= company.length; i++) {
        setInputValue(input, company.slice(0, i));
        await sleep(70 + Math.random() * 90, signal);
      }

      // 450ms debounce + query round-trip → the first result cards.
      let card = await poll(findCard, {
        intervalMs: 250,
        timeoutMs: 12_000,
        signal,
      });
      if (!card) {
        // Typing never committed a search (hydration hiccup) — recover via the URL.
        const win = frame.contentWindow;
        if (win && !win.location.search.includes('search=')) {
          win.location.replace(`/?search=${encodeURIComponent(company)}`);
          card = await poll(findCard, {
            intervalMs: 250,
            timeoutMs: 12_000,
            signal,
          });
        }
      }
      if (!card) return; // genuinely no results — leave the real empty state showing

      setStage('results');
      // Beat on the streamed-in rows, then pull back to the full scene for the click.
      await sleep(500, signal);
      setShot({ rect: null, ms: 1500 });
      await sleep(1700, signal);

      const cardName = card.querySelector('h3')?.textContent?.trim();
      clickLink(card);
      setStage('details');
      if (cardName) setTitle(cardName);

      // Prefer the real document title once the details route commits it.
      const detailsTitle = await poll(
        () => {
          const t = doc()?.title;
          const cleaned = t ? cleanTitle(t) : '';
          return cleaned && cleaned !== HOME_TITLE ? cleaned : null;
        },
        { intervalMs: 300, timeoutMs: 5_000, signal },
      );
      if (detailsTitle) setTitle(detailsTitle);

      // Camera: move in on the details header, hold, then pull away to the whole scene.
      const heading = await poll(
        () => doc()?.querySelector<HTMLElement>('main h1') ?? null,
        { intervalMs: 200, timeoutMs: 4_000, signal },
      );
      if (heading) {
        setShot({
          rect: toRect(heading.getBoundingClientRect()),
          padX: 160,
          padY: 130,
          maxZ: 1.9,
          ms: 1000,
        });
        await sleep(2200, signal);
      }
      setShot({ rect: null, ms: 1800 });
    }

    // Rejections are aborts/stalls — the preview just stays on its last stage.
    run().catch(() => {});

    return () => controller.abort();
  }, [frameRef, paneRef, company]);

  return { stage, title, canGoBack: stage === 'details', shot };
}
