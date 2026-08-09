import { useEffect, useRef, useState } from 'react';

import { Logo } from './Logo';

/**
 * How long the mark would take to reach full colour if nothing interrupted it. Deliberately
 * longer than a start ever takes: the reveal is meant to still be running when the app is
 * ready, so that finishing it IS the handover. Set near the real load time instead and it
 * lands on colour early and sits there, which is indistinguishable from no animation.
 */
const CREEP_MS = 6000;
/** Once the app is ready, whatever is left of the reveal is played out over this. */
const FINISH_MS = 260;
/** Paired with the `.splash--leaving` transition in style.css. */
const FADE_MS = 160;

const REVEAL: Keyframe[] = [
  { filter: 'grayscale(1)', opacity: 0.7, transform: 'scale(0.985)' },
  { filter: 'grayscale(0)', opacity: 1, transform: 'scale(1)' },
];

/**
 * The launch splash: the wordmark on the app's ink background, mirroring the installed-PWA
 * splash (`.app-splash` in the web app, and INITIAL_BG in the shell — keep the three in
 * lockstep). It starts at the site footer's resting grey and comes up into full colour.
 *
 * The reveal is deliberately not on a fixed clock. A load can take anywhere from a moment
 * to several seconds, and a short animation on a long load lands on colour immediately and
 * then waits — which reads as no animation at all. So it creeps, and whatever is left of it
 * is played out at speed the moment the app is ready. Grey, then colour, then the app, in
 * that order, however long the wait turns out to be.
 */
export function SplashScreen() {
  const markRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const mark = markRef.current;
    if (!mark) return;
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    // Reduced motion gets the destination, not the journey.
    const reveal = reduced
      ? null
      : mark.animate(REVEAL, {
          // Linear: the creep stands in for progress, so it should advance at a steady
          // visible rate rather than rushing the front and crawling the rest.
          duration: CREEP_MS,
          easing: 'linear',
          fill: 'forwards',
        });
    if (reduced) mark.style.cssText = 'filter:grayscale(0);opacity:1';

    const off = window.titlebar.onSplashDismiss(() => {
      void (async () => {
        if (reveal) {
          // Speed up rather than jump: updatePlaybackRate keeps the current position, so
          // the mark carries on from wherever it had got to.
          const left = CREEP_MS - Number(reveal.currentTime ?? 0);
          if (left > FINISH_MS) reveal.updatePlaybackRate(left / FINISH_MS);
          await reveal.finished.catch(() => undefined);
        }
        setLeaving(true);
        setTimeout(() => window.titlebar.splashDone(), FADE_MS);
      })();
    });

    // Tell main this splash is mounted and laid out. The window is not shown until it
    // lands: `dom-ready` only means the document parsed, and showing on that opened an
    // empty rectangle that sat there for as long as this renderer took to mount.
    //
    // NOT requestAnimationFrame, however much a real painted frame would be the better
    // signal — the window is still hidden at this point and a hidden window runs no
    // frames, so waiting for one here deadlocks against the very show() it is gating. An
    // effect runs on a task instead, so it fires regardless, and by then the DOM is
    // committed: the window has something to draw the instant it appears.
    window.titlebar.splashPainted();

    return () => {
      off();
      reveal?.cancel();
    };
  }, []);

  return (
    <div className={`splash site-ground${leaving ? ' splash--leaving' : ''}`}>
      <div className="splash-streaks" aria-hidden="true" />
      <div className="splash-mark" ref={markRef}>
        <Logo className="splash-logo" />
      </div>
    </div>
  );
}
