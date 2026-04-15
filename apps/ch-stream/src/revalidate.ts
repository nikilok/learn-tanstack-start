import { CONFIG } from './config.ts';

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
