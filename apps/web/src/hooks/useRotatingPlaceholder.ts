import { useEffect, useState } from 'react';

const PLACEHOLDERS = [
  'search company...',
  'try "NHS Trust"',
  'try "BBC"',
  'try "University of Oxford"',
  'try "British Council"',
  'try "Royal Mail"',
];

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
