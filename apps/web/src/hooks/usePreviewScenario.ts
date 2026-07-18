import { type RefObject, useEffect, useState } from 'react';

import { cleanTitle, prefersReducedMotion } from '../utils';
import { APP_NAME } from '../utils/app-meta';

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
 * stream in, clicks the matching card through to its details page, then
 * scrolls that page to the bottom so the demo ends on the full map + footer.
 * Returns the camera shot plus the title/back state the fake title bar mirrors.
 * `ready` gates the whole scenario — the iframe mounts deferred, and refs
 * changing alone would never re-run the effect.
 */
export function usePreviewScenario(
  frameRef: RefObject<HTMLIFrameElement | null>,
  paneRef: RefObject<HTMLElement | null>,
  company: string,
  ready: boolean,
) {
  const [detailsReached, setDetailsReached] = useState(false);
  const [title, setTitle] = useState(APP_NAME);
  const [shot, setShot] = useState<PreviewShot>({ rect: null, ms: 0 });

  useEffect(() => {
    if (!ready) return;
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

    /** Eased scroll of the iframed page to its bottom — reads like a user scrolling; stops on abort. */
    const scrollDetailsToBottom = (ms: number) =>
      new Promise<void>((resolve) => {
        const win = frame.contentWindow;
        const scroller = doc()?.scrollingElement;
        if (!win || !scroller) {
          resolve();
          return;
        }
        const from = scroller.scrollTop;
        const start = performance.now();
        const ease = (t: number) =>
          t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const step = (now: number) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          // Re-read the target each frame: late map tiles / footer can still
          // be growing the page while we scroll.
          const to = scroller.scrollHeight - win.innerHeight;
          const t = Math.min(1, (now - start) / ms);
          scroller.scrollTop = from + (to - from) * ease(t);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });

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
      if (prefersReducedMotion()) {
        frame.contentWindow?.location.replace(
          `/?search=${encodeURIComponent(company)}`,
        );
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
      if (!card) {
        // Genuinely no results — show the real empty state from the wide shot,
        // never stranded close-up on the search box.
        setShot({ rect: null, ms: 1200 });
        return;
      }

      // Beat on the streamed-in rows, then pull back to the full scene for the click.
      await sleep(500, signal);
      setShot({ rect: null, ms: 1500 });
      await sleep(1700, signal);

      const cardName = card.querySelector('h3')?.textContent?.trim();
      clickLink(card);
      // Confirm the router actually navigated before flipping the chrome to the
      // details state — the anchor can go stale during the pre-click pause.
      const onDetails = () =>
        doc()?.location.pathname.startsWith('/company/') ? true : null;
      let navigated = await poll(onDetails, {
        intervalMs: 150,
        timeoutMs: 2_500,
        signal,
      });
      if (!navigated) {
        const retry = findCard();
        if (retry) clickLink(retry);
        navigated = await poll(onDetails, {
          intervalMs: 150,
          timeoutMs: 2_500,
          signal,
        });
      }
      if (!navigated) {
        setShot({ rect: null, ms: 800 });
        return;
      }
      setDetailsReached(true);
      if (cardName) setTitle(cardName);

      // Prefer the real document title once the details route commits it.
      const detailsTitle = await poll(
        () => {
          const t = doc()?.title;
          const cleaned = t ? cleanTitle(t) : '';
          return cleaned && cleaned !== APP_NAME ? cleaned : null;
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

      // Once the pull-back settles, read down to the bottom of the page so the
      // demo ends on the full map and footer, not a half-cropped map.
      await sleep(2000, signal);
      await scrollDetailsToBottom(2000);
    }

    // Rejections are aborts or stalls; on a live stall, at least bring the
    // camera home rather than leaving it stranded close-up.
    run().catch(() => {
      if (!signal.aborted) setShot({ rect: null, ms: 800 });
    });

    return () => controller.abort();
  }, [frameRef, paneRef, company, ready]);

  return { title, canGoBack: detailsReached, shot };
}
