import { CONFIG } from './config.ts';

let lastRevalidatedAt = 0;

/**
 * POST to the web app's revalidation endpoint so freshly updated Companies
 * House rows invalidate cached responses. Throttled to one call per
 * `REVALIDATE_MIN_INTERVAL_MS` so bursts of CH stream traffic can't blow past
 * Vercel's 5/min invalidate-by-tags limit; skipped updates accumulate in the
 * trail table and are drained on the next allowed call via the DB cursor.
 * No-ops silently when the URL or secret aren't configured; network errors
 * are logged but never rethrown so revalidation failures can't tear down the
 * stream loop.
 */
export async function triggerRevalidation(): Promise<void> {
  if (!CONFIG.REVALIDATE_URL || !CONFIG.REVALIDATE_SECRET) return;

  const now = Date.now();
  const elapsed = now - lastRevalidatedAt;
  if (elapsed < CONFIG.REVALIDATE_MIN_INTERVAL_MS) {
    const wait = Math.ceil(
      (CONFIG.REVALIDATE_MIN_INTERVAL_MS - elapsed) / 1000,
    );
    console.log(
      `[ch-stream] Revalidation skipped (throttled, ${wait}s until next allowed)`,
    );
    return;
  }

  lastRevalidatedAt = now;

  try {
    await fetch(CONFIG.REVALIDATE_URL, {
      method: 'POST',
      headers: { 'x-revalidate-secret': CONFIG.REVALIDATE_SECRET },
    });
    console.log('[ch-stream] Revalidation triggered');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ch-stream] Revalidation failed: ${msg}`);
  }
}
