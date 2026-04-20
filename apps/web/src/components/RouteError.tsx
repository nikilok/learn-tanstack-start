import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';
import { logError } from '../api/logError';

/**
 * Router-level error boundary UI. Ships the error message and stack to the
 * `logError` server fn on mount for server-side observability, then renders a
 * generic "Something went wrong" card with `Try again` (calls `reset`) and
 * `Go back` (history pop) affordances.
 */
export default function RouteError({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    logError({
      data: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }, [error]);

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <div className="glass rounded-lg p-6 text-center">
          <h1 className="text-xl font-semibold text-(--sea-ink)">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm text-(--sea-ink-soft)">
            An unexpected error occurred. Please try again.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-(--sea-ink) px-4 py-2 text-sm font-medium text-(--surface) transition hover:opacity-85"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="rounded-md border border-(--sea-ink-soft)/20 px-4 py-2 text-sm font-medium text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
            >
              Go back
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
