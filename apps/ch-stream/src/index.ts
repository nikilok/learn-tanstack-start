import { CONFIG, validateConfig } from './config.ts';
import {
  getLastTimepoint,
  loadCompanyNumbers,
  processEvent,
  saveTimepoint,
} from './processor.ts';
import { triggerRevalidation } from './revalidate.ts';
import { connectStream, RateLimitError, TimepointGoneError } from './stream.ts';
import type { CHStreamEvent } from './types.ts';

const dryRun = process.argv.includes('--dry-run');

validateConfig();

if (dryRun) {
  console.log('[ch-stream] Running in dry-run mode — no DB writes');
}

const count = await loadCompanyNumbers();
console.log(`[ch-stream] Loaded ${count} company numbers into memory`);

let lastTimepoint = await getLastTimepoint();
let eventsSinceFlush = 0;
let processed = 0;
let updated = 0;
let updatedSinceFlush = 0;
let skipped = 0;

/**
 * Per-event callback handed to `connectStream`: filters to company-profile
 * events, updates counters, advances the local timepoint, and flushes the
 * cursor + triggers revalidation every `TIMEPOINT_FLUSH_INTERVAL` events.
 * Skips DB writes and revalidation when `--dry-run` is set.
 */
async function handleEvent(event: CHStreamEvent): Promise<void> {
  if (!event.resource_kind.startsWith('company-profile')) return;

  const wasUpdated = await processEvent(event, dryRun);
  if (wasUpdated) {
    updated++;
    updatedSinceFlush++;
  } else {
    skipped++;
  }
  processed++;

  lastTimepoint = event.event.timepoint;
  eventsSinceFlush++;

  if (eventsSinceFlush >= CONFIG.TIMEPOINT_FLUSH_INTERVAL) {
    if (!dryRun) {
      await saveTimepoint(lastTimepoint);
      if (updatedSinceFlush > 0) {
        await triggerRevalidation();
      }
    }
    eventsSinceFlush = 0;
    updatedSinceFlush = 0;
    console.log(
      `[ch-stream] timepoint=${lastTimepoint} processed=${processed} updated=${updated} skipped=${skipped}`,
    );
  }
}

console.log(
  `[ch-stream] Starting from timepoint: ${lastTimepoint ?? 'latest'}`,
);

while (true) {
  try {
    await connectStream(lastTimepoint, handleEvent);
    console.log('[ch-stream] Stream ended, reconnecting...');
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn('[ch-stream] 429 rate limited. Waiting 60s before retry...');
      await Bun.sleep(CONFIG.RETRY_DELAY_429_MS);
    } else if (err instanceof TimepointGoneError) {
      console.warn(
        '[ch-stream] Timepoint too old (416). Reconnecting from latest...',
      );
      lastTimepoint = null;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ch-stream] Disconnected: ${msg}. Reconnecting in ${CONFIG.RECONNECT_DELAY_MS / 1000}s...`,
      );
      await Bun.sleep(CONFIG.RECONNECT_DELAY_MS);
    }
  }

  if (lastTimepoint !== null && !dryRun) {
    await saveTimepoint(lastTimepoint);
  }

  if (updatedSinceFlush > 0) {
    await triggerRevalidation();
    updatedSinceFlush = 0;
  }
}
