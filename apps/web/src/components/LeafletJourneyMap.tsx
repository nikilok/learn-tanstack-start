import L from 'leaflet';
import { Marker, Polyline } from 'react-leaflet';

import type { Geocoded } from '../api/geocode';
import { useIsDark } from '../hooks/useIsDark';
import { unionJackIcon } from './LeafletMap';
import { MapShell } from './MapShell';

// Hollow ring for the previous address, echoing the timeline's neutral dot.
const previousIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:9999px;border:2px solid var(--sea-ink-soft);background:var(--sponsor-card-bg);box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`,
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/**
 * Leaflet map for a registered-address move: hollow marker on the previous
 * address, dotted line to the Union-Jack pin on the new one, bounds fitted to
 * both. Client-only lazy import like `LeafletMap` — Leaflet can't SSR.
 */
export default function LeafletJourneyMap({
  from,
  to,
}: {
  from: Geocoded;
  to: Geocoded;
}) {
  const isDark = useIsDark();
  const fromPos: [number, number] = [from.lat, from.lon];
  const toPos: [number, number] = [to.lat, to.lon];
  return (
    <MapShell
      bounds={L.latLngBounds(fromPos, toPos)}
      // Tight fit: fractional zoom (integer zoomSnap rounds the fit a whole
      // level out) + just enough padding for the 42px pin graphic.
      boundsOptions={{
        paddingTopLeft: [24, 52],
        paddingBottomRight: [24, 20],
        maxZoom: 16,
      }}
      zoomSnap={0.25}
    >
      <Polyline
        positions={[fromPos, toPos]}
        pathOptions={{
          color: isDark ? '#94a3b8' : '#475569',
          weight: 2.5,
          opacity: 0.9,
          dashArray: '1 9',
          lineCap: 'round',
        }}
      />
      <Marker position={fromPos} icon={previousIcon} title="Previous address" />
      <Marker position={toPos} icon={unionJackIcon} title="New address" />
    </MapShell>
  );
}
