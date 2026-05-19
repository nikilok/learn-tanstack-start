import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import type { Geocoded } from '../api/geocode';

const LeafletMap = lazy(() => import('./LeafletMap'));

/** Renders a Leaflet map of `geo` on the client only. The Leaflet bundle is code-split via `React.lazy`, and `<ClientOnly>` keeps it out of the SSR render (Leaflet can't run on the server). */
export function AddressMap({
  geo,
  companyName,
}: {
  geo: Geocoded;
  companyName?: string;
}) {
  return (
    <div className="relative h-64 w-full bg-(--sea-ink-soft)/10">
      <ClientOnly>
        <Suspense>
          <LeafletMap geo={geo} companyName={companyName} />
        </Suspense>
      </ClientOnly>
    </div>
  );
}
