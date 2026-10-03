import { isNotFound } from '@tanstack/react-router';

/** The message a caller receives when a server function fails. */
export const SERVER_FN_ERROR_MESSAGE = 'Internal server error';

const MESSAGE_LIMIT = 300;
const CAUSE_LIMIT = 200;

/**
 * The error a server function's caller may see. Not-founds and Responses
 * (redirects included) are control flow and pass through unchanged; anything
 * else is replaced by a generic Error carrying none of the original's message.
 */
export function clientSafeError(error: unknown): unknown {
  if (isNotFound(error) || error instanceof Response) return error;
  return new Error(SERVER_FN_ERROR_MESSAGE);
}

/** An error's name and message, or the thrown value as text: one line, control characters blanked, cut to `limit` characters. */
function describe(error: unknown, limit: number): string {
  const text = (
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  ).replace(/[\s\p{Cc}]+/gu, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One bounded log line for a failed server function: its name, the error and its cause, never a stack. Never throws, so the caller's replacement error is always thrown. */
export function failureLogLine(fnName: string, error: unknown): string {
  try {
    const cause =
      error instanceof Error && error.cause !== undefined
        ? ` (cause: ${describe(error.cause, CAUSE_LIMIT)})`
        : '';
    return `[ServerFn] ${fnName} failed: ${describe(error, MESSAGE_LIMIT)}${cause}`;
  } catch {
    return `[ServerFn] ${fnName} failed: [unprintable error]`;
  }
}
