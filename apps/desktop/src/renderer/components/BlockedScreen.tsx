import { useEffect, useState } from 'react';

import { RunnerCanvas } from '../game/RunnerCanvas';

// One line, so keep each of these to a clause. The countdown is appended to it.
const REASON: Record<BlockReason, string> = {
  // No duration here on purpose: how long a refusal lasts is not something a public repo
  // should write down, and the countdown below already tells the user when the next check
  // runs. The screen clears itself either way.
  blocked: 'Too many requests. Your page comes back on its own.',
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

  // Tell main the moment there is a frame on the glass. The launch splash is held until
  // this arrives, so a launch that cannot reach the site goes splash -> game with nothing
  // blank in between. Two frames deep on purpose: the first only schedules this screen's
  // paint, and reporting from it hands over to a window that is still empty.
  //
  // The timeout is not belt-and-braces: a hidden window runs no frames at all, so on a
  // launch where this screen comes up before the window has been shown, rAF would never
  // fire and the splash would sit on its backstop instead of handing over.
  const up = state !== null;
  useEffect(() => {
    if (!up) return;
    let done = false;
    const report = () => {
      if (done) return;
      done = true;
      window.titlebar.blockedPainted();
    };
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(report);
    });
    const fallback = setTimeout(report, 200);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(fallback);
    };
  }, [up]);

  if (!state) return null;

  return (
    <div className="blocked site-ground">
      {/* The run turns the sky over as it goes, and the page behind the canvas goes with
          it — the status line and the ground gradient are the app's tokens, so leaving
          them on the old theme would strand a light footer under a night sky. Nothing has
          to undo it: the shell re-stamps the class from its own theme on the next report,
          and this whole view goes away when the site comes back. */}
      <RunnerCanvas
        active
        dark={dark}
        onSky={(night) =>
          document.documentElement.classList.toggle('dark', night)
        }
      />
      <div className="blocked-status">
        {/* The reason leads and is meant to be read at a glance: someone landing on a game
            instead of their app needs to know why before anything else. */}
        <p className="blocked-reason">{REASON[state.reason]}</p>
        <p className="blocked-meta">
          <span className="blocked-countdown">
            {state.checking
              ? 'Checking now.'
              : `Checking again in ${clock(left)}.`}
          </span>{' '}
          {/* The announcement lives here rather than on the countdown itself, which ticks
              every half second and would read the whole line out again on each one. This
              region is empty until a check starts, so it speaks once when one does.
              Present from the first render on purpose: a live region created at the same
              moment as its content is not reliably observed, so switching aria-live on
              and off around the countdown would have traded a stream of noise for an
              announcement that may never arrive. */}
          <span className="sr-only" aria-live="polite">
            {state.checking ? 'Checking now.' : ''}
          </span>
          {/* aria-disabled, not disabled: a disabled element cannot hold focus, so
              pressing this with the keyboard dropped focus to <body> — where the game's
              own key handler takes over, and the next Space started a run instead of
              re-pressing the button. Staying focusable also keeps it matching the
              `closest('button')` guard that keeps the game out of the way. */}
          <button
            type="button"
            className="blocked-retry no-drag"
            onClick={() => {
              if (state.checking) return;
              window.titlebar.retryBlocked();
            }}
            aria-disabled={state.checking}
          >
            Try now
          </button>
        </p>
      </div>
    </div>
  );
}
