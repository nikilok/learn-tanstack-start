import { CONFIG } from './config.ts';

/**
 * POST to the web app's revalidation endpoint so freshly updated Companies
 * House rows invalidate cached responses. No-ops silently when the URL or
 * secret aren't configured; network errors are logged but never rethrown so
 * revalidation failures can't tear down the stream loop.
 */
export async function triggerRevalidation(): Promise<void> {
  if (!CONFIG.REVALIDATE_URL || !CONFIG.REVALIDATE_SECRET) return;

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
