// One async data source for a side pane. Each pane keeps its own copy so switching between them
// is instant, and a refresh keeps the previous result on screen until the new one lands.

import { useCallback, useRef, useState } from 'react';

import { errMsg } from '../util';

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
  // The generation whose load is currently running, or null. Not a boolean: a plain in-flight
  // flag also blocked the load that reset() is immediately followed by, so a window change left
  // the pane empty until something else happened to refetch it.
  const flying = useRef<number | null>(null);
  // Bumped by reset(). A load that started before it belongs to a window no longer on screen,
  // so its result must be dropped rather than written back over the cleared state.
  const generation = useRef(0);

  const load = useCallback(
    async (fetcher: () => Promise<T>): Promise<LoadResult> => {
      // Only a duplicate WITHIN the same generation is dropped. A newer generation supersedes
      // whatever is in flight — that one's result is already going to be discarded.
      if (flying.current === generation.current) return 'skipped';
      const mine = generation.current;
      flying.current = mine;
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
        // Only the newest load owns the spinner. A superseded one clearing it would hide the
        // successor's; keying that on the generation rather than on "did anything supersede me"
        // is what stops a superseded load with NO successor leaving the spinner up forever.
        if (flying.current === mine) {
          flying.current = null;
          setLoading(false);
        }
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
