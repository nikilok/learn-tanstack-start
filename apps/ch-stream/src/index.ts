import { CONFIG, validateConfig } from './config.ts';
import {
  getLastTimepoint,
  loadCompanyNumbers,
  processEvent,
  saveTimepoint,
} from './processor.ts';
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
let skipped = 0;

async function handleEvent(event: CHStreamEvent): Promise<void> {
  if (event.resource_kind !== 'company-profile#company-profile') return;

  const wasUpdated = await processEvent(event, dryRun);
  if (wasUpdated) updated++;
  else skipped++;
  processed++;

  lastTimepoint = event.event.timepoint;
  eventsSinceFlush++;

  if (eventsSinceFlush >= CONFIG.TIMEPOINT_FLUSH_INTERVAL) {
    if (!dryRun) {
      await saveTimepoint(lastTimepoint);
    }
    eventsSinceFlush = 0;
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
      console.error('[ch-stream] Connection error:', err);
      await Bun.sleep(CONFIG.RECONNECT_DELAY_MS);
    }
  }

  if (lastTimepoint !== null && !dryRun) {
    await saveTimepoint(lastTimepoint);
  }
}
