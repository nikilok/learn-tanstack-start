import { useSuspenseQueries } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { geocodeQueryOptions } from '../api/geocode';
import { isRenderingBot } from '../utils/rendering-bot';
import { MapErrorBoundary } from './MapErrorBoundary';

const LeafletJourneyMap = lazy(() => import('./LeafletJourneyMap'));

const FRAME_CLASS =
  'relative mt-2 h-64 w-full overflow-hidden rounded-md bg-(--sea-ink-soft)/10';

const placeholder = <div className={FRAME_CLASS} />;

/** Geocodes both ends of a move and renders the journey map. Returns nothing when either side fails to geocode, so the placeholder collapses. */
function GeocodedJourney({ from, to }: { from: string; to: string }) {
  const [fromGeo, toGeo] = useSuspenseQueries({
    queries: [geocodeQueryOptions(from), geocodeQueryOptions(to)],
  });
  if (!fromGeo.data || !toGeo.data) return null;
  return (
    <div className={FRAME_CLASS}>
      <LeafletJourneyMap from={fromGeo.data} to={toGeo.data} />
    </div>
  );
}

/**
 * Old-address → new-address map for a timeline address change. Renders a
 * placeholder until scrolled near the viewport, then geocodes and mounts the
 * map — below-fold timeline maps must not compete with the main map's tiles
 * (the page's LCP) or fire geocodes nobody sees.
 */
export function AddressChangeMap({ from, to }: { from: string; to: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    // Crawler renders never go "near": the frame stays a static placeholder.
    if (isRenderingBot(navigator.userAgent)) return;
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setNear(true);
      },
      { rootMargin: '300px' },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  if (!near) return <div ref={frameRef} className={FRAME_CLASS} />;

  return (
    <MapErrorBoundary>
      <Suspense fallback={placeholder}>
        <GeocodedJourney from={from} to={to} />
      </Suspense>
    </MapErrorBoundary>
  );
}
