import { CONFIG } from './config.ts';
import type { CHStreamEvent } from './types.ts';

const AUTH_HEADER = `Basic ${Buffer.from(`${CONFIG.API_KEY}:`).toString('base64')}`;

/**
 * Thrown when the Companies House stream returns HTTP 429, signalling the
 * caller should back off for `RETRY_DELAY_429_MS` before reconnecting.
 */
export class RateLimitError extends Error {
  constructor() {
    super('Rate limited (429)');
    this.name = 'RateLimitError';
  }
}

/**
 * Thrown on HTTP 416 when the requested timepoint has aged out of the stream
 * window. Callers should drop the stored cursor and reconnect from the
 * latest available timepoint.
 */
export class TimepointGoneError extends Error {
  constructor() {
    super('Timepoint too old (416)');
    this.name = 'TimepointGoneError';
  }
}

/**
 * Open the Companies House profile stream (optionally from `timepoint`) and
 * invoke `onEvent` for each NDJSON event parsed from the response body. Maps
 * 429/416 responses to typed errors so the caller can apply the right retry
 * strategy; malformed lines are logged and skipped rather than fatal.
 */
export async function connectStream(
  timepoint: number | null,
  onEvent: (event: CHStreamEvent) => Promise<void>,
): Promise<void> {
  const url = timepoint
    ? `${CONFIG.STREAM_URL}?timepoint=${timepoint}`
    : CONFIG.STREAM_URL;

  const response = await fetch(url, {
    headers: { Authorization: AUTH_HEADER },
  });

  if (response.status === 429) throw new RateLimitError();
  if (response.status === 416) throw new TimepointGoneError();

  if (!response.ok) {
    throw new Error(
      `Stream returned ${response.status}: ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error('Stream response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('<')) continue;
        try {
          const event = JSON.parse(trimmed) as CHStreamEvent;
          await onEvent(event);
        } catch {
          console.warn(
            `[ch-stream] Failed to parse event: ${trimmed.slice(0, 100)}`,
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
