import { useEffect, useState } from 'react';

const PLACEHOLDERS = [
  'search company...',
  'try "NHS Trust"',
  'try "BBC"',
  'try "University of Oxford"',
  'try "British Council"',
  'try "Royal Mail"',
];

/**
 * Hook that cycles through a fixed list of example-search placeholders every
 * 3s, appending the shortcut hint (e.g. `(⌘K)`) when provided. Rotation stops
 * and the index resets to 0 when `paused` is true — used while the input is
 * focused or has a value.
 */
export function useRotatingPlaceholder(shortcut: string, paused = false) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % PLACEHOLDERS.length);
    }, 3000);
    return () => {
      clearInterval(interval);
      setIndex(0);
    };
  }, [paused]);

  const base = PLACEHOLDERS[index];
  return shortcut ? `${base} (${shortcut})` : base;
}
