import { useEffect, useState } from 'react';

import { RunnerCanvas } from '../game/RunnerCanvas';

// One line, so keep each of these to a clause. The countdown is appended to it.
const REASON: Record<BlockReason, string> = {
  blocked: 'Too many requests, usually clear within 10 minutes.',
  offline: 'You are offline.',
  unreachable: 'SponsorSearch is not answering.',
};

/** Whole seconds until `at`, floored at zero. */
function secondsUntil(at: number): number {
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** m:ss for the retry countdown. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds - m * 60).padStart(2, '0')}`;
}

/**
 * The local stand-in for the site, shown when it cannot be reached or is refusing us.
 * Everything here is bundled with the app, so it renders with no network at all: the game
 * is the screen, and the one line under it is the whole status. The main process is what
 * watches for the way back.
 */
export function BlockedScreen() {
  const [state, setState] = useState<BlockState | null>(null);
  const [dark, setDark] = useState(true);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const offTheme = window.titlebar.onTheme((t) => {
      document.documentElement.classList.toggle('dark', t.dark);
      setDark(t.dark);
    });
    const offBlocked = window.titlebar.onBlocked(setState);
    window.titlebar.ready();
    return () => {
      offTheme();
      offBlocked();
    };
  }, []);

  // Ticks the countdown locally; main only sends a new deadline when one is set.
  useEffect(() => {
    if (!state) return;
    setLeft(secondsUntil(state.retryAt));
    const id = setInterval(() => setLeft(secondsUntil(state.retryAt)), 500);
    return () => clearInterval(id);
  }, [state]);

  if (!state) return null;

  return (
    <div className="blocked">
      <RunnerCanvas active dark={dark} />
      <p className="blocked-status">
        <span>{REASON[state.reason]}</span>{' '}
        <span className="blocked-countdown">
          {state.checking
            ? 'Checking now.'
            : `Checking again in ${clock(left)}.`}
        </span>{' '}
        <button
          type="button"
          className="blocked-retry no-drag"
          onClick={() => window.titlebar.retryBlocked()}
          disabled={state.checking}
        >
          Try now
        </button>
      </p>
    </div>
  );
}
