import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  advanceExamples,
  ASK_EXAMPLES,
  EXAMPLE_ERASE_MS,
  EXAMPLE_TYPE_MS,
  exampleDwellMs,
  exampleWaitMs,
  FIRST_EXAMPLE,
  letters,
} from '../lib/ask/examples';

import styles from './AskExamples.module.css';

/** The beats the letters keep, for the stylesheet: the timer's own, from lib/ask/examples. */
const BEATS = {
  '--beat': `${EXAMPLE_TYPE_MS}ms`,
  '--erase': `${EXAMPLE_ERASE_MS}ms`,
} as CSSProperties;

/** An example letter by letter, each on its own beat. */
function Letters({ text }: { text: string }) {
  return letters(text).map((letter, i) => (
    <span
      key={i}
      className={styles.letter}
      style={{ '--i': i } as CSSProperties}
    >
      {letter}
    </span>
  ));
}

/**
 * The hero's ask row: "Ask for" and one example of what the register can be
 * asked, rotating through lib/ask/examples and asked as written on a click.
 * Each example types in letter by letter once the one before it has been
 * erased, right to left and quickly, the row re-centring as it goes. The
 * rotation pauses under the pointer and on focus, so what is read is what is
 * asked, and never runs under reduced motion.
 */
export default function AskExamples({
  onAsk,
}: {
  onAsk: (text: string) => void;
}) {
  const [rotation, setRotation] = useState(FIRST_EXAMPLE);
  // True once the example the shown one replaced has been erased, and it goes.
  const [erased, setErased] = useState(false);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const cellRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (paused || still) return;
    const timer = setTimeout(() => {
      setRotation((current) => advanceExamples(current));
      setErased(false);
    }, exampleDwellMs(rotation));
    return () => clearTimeout(timer);
  }, [paused, still, rotation]);

  // A swap glides the cell from the width of the example erased to the shown one's over the erase,
  // so the row re-centres with the letters instead of jumping once they have gone.
  useLayoutEffect(() => {
    const cell = cellRef.current;
    if (rotation.leaving === null || !cell) return;
    const [leaving, shown] = cell.children;
    if (!leaving || !shown) return;
    const from = leaving.getBoundingClientRect().width;
    const to = shown.getBoundingClientRect().width;
    cell.style.transition = 'none';
    cell.style.width = `${from}px`;
    void cell.offsetWidth;
    cell.style.transition = `width ${EXAMPLE_ERASE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    cell.style.width = `${to}px`;
  }, [rotation]);

  const shown = ASK_EXAMPLES[rotation.shown];
  return (
    <button
      type="button"
      className={styles.examples}
      style={BEATS}
      onClick={() => onAsk(shown)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.mark} aria-hidden="true" />
      <span>Ask for</span>
      <span className={styles.break} aria-hidden="true" />
      <span ref={cellRef} className={styles.phrase}>
        {rotation.leaving !== null && !erased && (
          <span
            key={`out-${rotation.leaving}`}
            className={styles.leaving}
            aria-hidden="true"
            style={
              {
                '--n': letters(ASK_EXAMPLES[rotation.leaving]).length,
              } as CSSProperties
            }
            // Its own animation ends with the erase, the last letter gone: the cell is the shown one's to size.
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return;
              const cell = cellRef.current;
              if (cell) {
                cell.style.width = '';
                cell.style.transition = '';
              }
              setErased(true);
            }}
          >
            <Letters text={ASK_EXAMPLES[rotation.leaving]} />
          </span>
        )}
        <span
          key={`in-${rotation.shown}`}
          className={styles.shown}
          style={
            {
              '--wait': `${exampleWaitMs(rotation)}ms`,
              '--n': letters(shown).length,
            } as CSSProperties
          }
        >
          <span aria-hidden="true">
            <Letters text={shown} />
          </span>
          <span className="sr-only">{shown}</span>
        </span>
      </span>
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        className={styles.go}
      >
        <path d="M10 16a.75.75 0 01-.75-.75V6.56L5.03 10.78a.75.75 0 01-1.06-1.06l5.5-5.5a.75.75 0 011.06 0l5.5 5.5a.75.75 0 11-1.06 1.06L10.75 6.56v8.69A.75.75 0 0110 16z" />
      </svg>
    </button>
  );
}
