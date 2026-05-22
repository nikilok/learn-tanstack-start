import { useSuspenseQuery } from '@tanstack/react-query';
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { geocodeQueryOptions } from '../api/geocode';

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

/** Client-only map for `address`. Streams in after the rest of the page renders — Leaflet can't SSR and Nominatim is too slow to block on. */
export function AddressMap({
  address,
  companyName,
}: {
  address: string;
  companyName?: string;
}) {
  return (
    <ClientOnly>
      <Suspense fallback={placeholder}>
        <GeocodedMap address={address} companyName={companyName} />
      </Suspense>
    </ClientOnly>
  );
}
