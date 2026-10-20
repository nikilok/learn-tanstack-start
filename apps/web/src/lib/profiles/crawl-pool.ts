/**
 * Cross-origin concurrency for the crawl sweep. Politeness stays inside an
 * origin (crawlOrigin's per-page delay); this module decides only how many
 * origins crawl at once, and never lets two origins of one site overlap.
 */

/**
 * The lane an origin crawls in: its host without scheme, port or a leading
 * `www.`, so the www and scheme variants of one site share a lane. An
 * unparsable origin keeps its own string, which is still one lane per value.
 */
export function siteLane(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

export type PoolOptions<T> = {
  /** Most items in flight at once; a positive integer. */
  concurrency: number;
  laneOf: (item: T) => string;
  run: (item: T) => Promise<void>;
  /** Checked before every start; once true, nothing new starts. */
  stop?: () => boolean;
};

/**
 * Run each item through `run` at most once, with at most `concurrency` in
 * flight and never two sharing a lane. Items start in queue order as lanes
 * allow, so a head waiting on a busy lane lets later items go first. Resolves
 * when nothing is in flight; a rejection stops new starts and is rethrown once
 * the items already running have settled.
 */
export async function runPool<T>(
  items: readonly T[],
  options: PoolOptions<T>,
): Promise<void> {
  const { concurrency, laneOf, run, stop = () => false } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const queue = items.map((item) => ({ item, lane: laneOf(item) }));
  const busy = new Set<string>();
  let inFlight = 0;
  let failure: { error: unknown } | null = null;

  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      try {
        while (!failure && inFlight < concurrency && !stop()) {
          const index = queue.findIndex((entry) => !busy.has(entry.lane));
          if (index === -1) break;
          const [entry] = queue.splice(index, 1);
          busy.add(entry.lane);
          inFlight++;
          // The executor runs `run` synchronously and turns a throw into a rejection.
          new Promise<void>((done) => done(run(entry.item)))
            .catch((error: unknown) => {
              failure ??= { error };
            })
            .finally(() => {
              busy.delete(entry.lane);
              inFlight--;
              pump();
            });
        }
      } catch (error) {
        failure ??= { error };
      }
      if (inFlight > 0) return;
      if (failure) reject(failure.error);
      else resolve();
    };
    pump();
  });
}
