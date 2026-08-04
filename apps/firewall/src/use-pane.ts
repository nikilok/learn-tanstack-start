// One async data source for a side pane. Each pane keeps its own copy so switching between them
// is instant, and a refresh keeps the previous result on screen until the new one lands.

import { useCallback, useRef, useState } from 'react';

import { errMsg } from './util';

export type Pane<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  /** Run `fetcher`, deduping concurrent calls. Resolves once the state has settled. */
  load: (fetcher: () => Promise<T>) => Promise<void>;
  /** Drop the cached result so the next load actually refetches — a window change invalidates it. */
  reset: () => void;
};

export function usePane<T>(): Pane<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async (fetcher: () => Promise<T>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      setData(await fetcher());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError('');
  }, []);

  return { data, error, loading, load, reset };
}
