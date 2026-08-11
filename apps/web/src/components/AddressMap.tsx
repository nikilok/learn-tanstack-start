import { useSuspenseQuery } from '@tanstack/react-query';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { geocodeQueryOptions } from '../api/geocode';
import { isRenderingBot } from '../utils/rendering-bot';
import { MapErrorBoundary } from './MapErrorBoundary';

const LeafletMap = lazy(() => import('./LeafletMap'));

const placeholder = (
  <div className="relative h-64 w-full bg-(--sea-ink-soft)/10" />
);

/** Geocodes `address` client-side and renders a Leaflet map. Suspends on the geocode query so the route loader doesn't block on Nominatim (~600ms). Returns nothing if geocoding fails so the placeholder collapses. */
function GeocodedMap({
  address,
  companyName,
}: {
  address: string;
  companyName?: string;
}) {
  const { data: geo } = useSuspenseQuery(geocodeQueryOptions(address));
  if (!geo) return null;
  return (
    <div className="relative h-64 w-full bg-(--sea-ink-soft)/10">
      <LeafletMap geo={geo} companyName={companyName} />
    </div>
  );
}

/** Client half of AddressMap: crawler renders hold the placeholder frame instead of mounting the map — the page keeps its first-paint structure with none of the geocode, Leaflet or tile spend. The geocode fn refuses crawlers anyway. */
function CrawlerGatedMap({
  address,
  companyName,
}: {
  address: string;
  companyName?: string;
}) {
  if (isRenderingBot(navigator.userAgent)) return placeholder;
  return (
    <MapErrorBoundary>
      <Suspense fallback={placeholder}>
        <GeocodedMap address={address} companyName={companyName} />
      </Suspense>
    </MapErrorBoundary>
  );
}

/** Client-only map for `address`. Streams in after the rest of the page renders — Leaflet can't SSR and Nominatim is too slow to block on. */
export function AddressMap({
  address,
  companyName,
}: {
  address: string;
  companyName?: string;
}) {
  return (
    <ClientOnly fallback={placeholder}>
      <CrawlerGatedMap address={address} companyName={companyName} />
    </ClientOnly>
  );
}
