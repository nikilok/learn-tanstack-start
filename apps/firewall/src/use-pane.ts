// One async data source for a side pane. Each pane keeps its own copy so switching between them
// is instant, and a refresh keeps the previous result on screen until the new one lands.

import { useCallback, useRef, useState } from 'react';

import { errMsg } from './util';

/** `skipped` means a concurrent load was already running and this call did nothing. */
export type LoadResult = 'ok' | 'error' | 'skipped';

export type Pane<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  /** Run `fetcher`, deduping concurrent calls. Resolves once the state has settled, reporting what actually happened — a caller driving a backoff cannot infer that from the pane, whose ref lags a render behind. */
  load: (fetcher: () => Promise<T>) => Promise<LoadResult>;
  /** Drop the cached result so the next load actually refetches — a window change invalidates it. */
  reset: () => void;
};

export function usePane<T>(): Pane<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  // Bumped by reset(). A load that started before it belongs to a window no longer on screen,
  // so its result must be dropped rather than written back over the cleared state.
  const generation = useRef(0);

  const load = useCallback(
    async (fetcher: () => Promise<T>): Promise<LoadResult> => {
      if (inFlight.current) return 'skipped';
      inFlight.current = true;
      const mine = generation.current;
      setLoading(true);
      setError('');
      try {
        const next = await fetcher();
        if (mine !== generation.current) return 'skipped';
        setData(next);
        return 'ok';
      } catch (e) {
        if (mine !== generation.current) return 'skipped';
        setError(errMsg(e));
        return 'error';
      } finally {
        inFlight.current = false;
        // Only the current generation owns the spinner; a superseded load clearing it would
        // hide the one that replaced it.
        if (mine === generation.current) setLoading(false);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setData(null);
    setError('');
  }, []);

  return { data, error, loading, load, reset };
}
