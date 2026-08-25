import { useEffect, useId, useRef, useState } from 'react';

import {
  afterPrompt,
  canPrompt,
  DISCORD_PROMPT_DISMISSED,
  DISCORD_PROMPT_KEY,
} from '../lib/discord-prompt';

import styles from './DiscordLink.module.css';

/* The Discord mark split into three: the face is the mask's white ground and each eye is a
   hole punched out of it, so the right eye can be squashed on its own. */
const FACE =
  'M13.545 2.907a13.227 13.227 0 0 0-3.257-1.011.05.05 0 0 0-.052.025c-.141.25-.297.577-.406.833a12.19 12.19 0 0 0-3.658 0 8.258 8.258 0 0 0-.412-.833.051.051 0 0 0-.052-.025c-1.125.194-2.22.534-3.257 1.011a.041.041 0 0 0-.021.018C.356 6.024-.213 9.047.066 12.032c.001.014.01.028.021.037a13.276 13.276 0 0 0 3.995 2.02.05.05 0 0 0 .056-.019c.308-.42.582-.863.818-1.329a.05.05 0 0 0-.01-.059.051.051 0 0 0-.018-.011 8.875 8.875 0 0 1-1.248-.595.05.05 0 0 1-.02-.066.051.051 0 0 1 .015-.019c.084-.063.168-.129.248-.195a.05.05 0 0 1 .051-.007c2.619 1.196 5.454 1.196 8.041 0a.052.052 0 0 1 .053.007c.08.066.164.132.248.195a.051.051 0 0 1-.004.085 8.254 8.254 0 0 1-1.249.594.05.05 0 0 0-.03.03.052.052 0 0 0 .003.041c.24.465.515.909.817 1.329a.05.05 0 0 0 .056.019 13.235 13.235 0 0 0 4.001-2.02.049.049 0 0 0 .021-.037c.334-3.451-.559-6.449-2.366-9.106a.034.034 0 0 0-.02-.019Z';
const EYE_LEFT =
  'M5.347 10.214c-.789 0-1.438-.724-1.438-1.612 0-.889.637-1.613 1.438-1.613.807 0 1.45.73 1.438 1.613 0 .888-.637 1.612-1.438 1.612Z';
const EYE_RIGHT =
  'M10.663 10.214c-.788 0-1.438-.724-1.438-1.612 0-.889.637-1.613 1.438-1.613.807 0 1.451.73 1.438 1.613 0 .888-.63 1.612-1.438 1.612Z';

/** Read the prompt budget; storage is unreadable in private mode, which reads as a fresh visitor. */
function readPrompt(): string | null {
  try {
    return window.localStorage.getItem(DISCORD_PROMPT_KEY);
  } catch {
    return null;
  }
}

/** Persist the prompt budget, ignoring a storage that refuses to take it. */
function writePrompt(value: string): void {
  try {
    window.localStorage.setItem(DISCORD_PROMPT_KEY, value);
  } catch {
    // storage may be unavailable (private mode); the reader is prompted again next visit
  }
}

/**
 * Discord icon for the footer's social row. Winks its right eye and then pops a comic
 * speech bubble — on hover / keyboard focus, and unprompted when the footer scrolls into
 * view, which is the only way the invitation reaches a touch device.
 *
 * The unprompted play is budgeted: three showings, or none at all once the reader has
 * clicked through. Past that it is a distraction, and only hover and focus still open it.
 */
export default function DiscordLink() {
  const maskId = `discord-eyes-${useId()}`;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const promptRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Nothing to arm without motion: the CSS plays neither animation, so the run would
    // never end and .playing would stick.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    promptRef.current = readPrompt();
    // Spent readers never even pay for the observer.
    if (!canPrompt(promptRef.current)) return;

    let armed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.intersectionRatio >= 1 &&
            !armed &&
            canPrompt(promptRef.current)
          ) {
            armed = true;
            setPlaying(true);
          } else if (entry.intersectionRatio <= 0) {
            armed = false;
            // Cancels a play the reader scrolled away from, so coming back starts a
            // fresh one instead of resuming the tail of the old run.
            setPlaying(false);
          }
        }
      },
      { threshold: [0, 1] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** The bubble is on screen, so the prompt is spent. Counting at the end instead would never record a reader who scrolls away mid-play, and they would be prompted for eternity. */
  const countPrompt = () => {
    promptRef.current = afterPrompt(promptRef.current);
    writePrompt(promptRef.current);
  };

  /** The run reached its own end; drop the class so hover and focus own the bubble again. */
  const endPlay = () => setPlaying(false);

  /** Clicking through is the answer the prompt was asking for, so stop asking. */
  const dismissPrompt = () => {
    promptRef.current = DISCORD_PROMPT_DISMISSED;
    writePrompt(DISCORD_PROMPT_DISMISSED);
  };

  return (
    <span
      ref={wrapRef}
      className={playing ? `${styles.wrap} ${styles.playing}` : styles.wrap}
    >
      <a
        href="https://discord.gg/nZrjp5sBQb"
        target="_blank"
        rel="noreferrer"
        onClick={dismissPrompt}
        className="rounded-md p-2 text-(--sea-ink-soft) no-underline transition hover:text-(--sea-ink)"
      >
        <span className="sr-only">Join the Discord</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" width="20" height="20">
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="16"
            height="16"
          >
            <path d={FACE} fill="#fff" />
            <path d={EYE_LEFT} fill="#000" />
            <path d={EYE_RIGHT} fill="#000" className={styles.eye} />
          </mask>
          <rect
            width="16"
            height="16"
            fill="currentColor"
            mask={`url(#${maskId})`}
          />
        </svg>
      </a>
      {/* Decorative: the link's own label already says where it goes. */}
      <span
        aria-hidden="true"
        className={styles.bubble}
        onAnimationStart={countPrompt}
        onAnimationEnd={endPlay}
      >
        Come chat or give feedback on our Discord
      </span>
    </span>
  );
}
