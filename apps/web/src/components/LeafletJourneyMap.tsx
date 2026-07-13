import L from 'leaflet';
import { Marker, Polyline } from 'react-leaflet';

import type { Geocoded } from '../api/geocode';
import { useIsDark } from '../hooks/useIsDark';
import { unionJackIcon } from './LeafletMap';
import { MapShell } from './MapShell';

import styles from './LeafletJourneyMap.module.css';

// --logo-red per theme. Set inline (below) rather than via a CSS class: a
// CSS-module class on Leaflet's <path> resolves in dev but drops in the Vite
// production build, leaving Leaflet's default blue stroke.
const LINE_COLOR = { light: '#c8102e', dark: '#f87171' } as const;

// Hollow ring for the previous address, echoing the timeline's neutral dot.
const previousIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:9999px;border:2px solid var(--sea-ink-soft);background:var(--sponsor-card-bg);box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`,
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** Human label for a move's straight-line distance, e.g. "moved 2.1 miles". */
function formatMoveDistance(meters: number): string {
  const miles = meters / 1609.344;
  const value = miles >= 10 ? Math.round(miles) : miles.toFixed(1);
  return `moved ${value} miles`;
}

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
  const fromLatLng = L.latLng(from.lat, from.lon);
  const toLatLng = L.latLng(to.lat, to.lon);
  const fromPos: [number, number] = [from.lat, from.lon];
  const toPos: [number, number] = [to.lat, to.lon];

  // Caption beside the current-location pin. Sit it on whichever side faces the
  // map centre (destination east of origin ⇒ pin sits right ⇒ caption goes left)
  // so a wide label can't run off the edge, with its inner edge a small gap past
  // the ~16px-half-width pin, level with the pin's body.
  const labelOnRight = toLatLng.lng <= fromLatLng.lng;
  const GAP = 22;
  const RISE = 22;
  const iconWidth = 150;
  const distanceIcon = L.divIcon({
    html: `<span class="${styles.distance}">${formatMoveDistance(fromLatLng.distanceTo(toLatLng))}</span>`,
    className: `${styles.distanceIcon} ${labelOnRight ? styles.onRight : styles.onLeft}`,
    iconSize: [iconWidth, 22],
    iconAnchor: [labelOnRight ? -GAP : iconWidth + GAP, 11 + RISE],
  });

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
          color: isDark ? LINE_COLOR.dark : LINE_COLOR.light,
          weight: 2.5,
          opacity: 0.9,
          dashArray: '1 9',
          lineCap: 'round',
        }}
      />
      <Marker position={fromPos} icon={previousIcon} title="Previous address" />
      <Marker position={toPos} icon={unionJackIcon} title="New address" />
      {/* Beside the current-location pin; non-interactive so it never blocks the map. */}
      <Marker position={toPos} icon={distanceIcon} interactive={false} />
    </MapShell>
  );
}
