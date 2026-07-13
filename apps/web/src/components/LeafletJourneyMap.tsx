import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { Marker, Polyline } from 'react-leaflet';

import type { Geocoded } from '../api/geocode';
import { useIsDark } from '../hooks/useIsDark';
import { prefersReducedMotion } from '../utils';
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

// Arc height as a fraction of the chord — a gentle bow, not a big loop.
const CURVE = 0.18;
const ARC_STEPS = 32;

/** A curved (quadratic Bézier) arc between two points, sampled as latlngs.
 * Computed in Mercator space — the map's own projection — so the bow reads
 * evenly rather than skewing with latitude. */
function curvedArc(from: L.LatLng, to: L.LatLng): L.LatLng[] {
  const merc = L.Projection.SphericalMercator;
  const p1 = merc.project(from);
  const p2 = merc.project(to);
  // Control point at the chord midpoint, pushed perpendicular to the chord.
  const control = L.point(
    (p1.x + p2.x) / 2 + (p2.y - p1.y) * CURVE,
    (p1.y + p2.y) / 2 - (p2.x - p1.x) * CURVE,
  );
  const points: L.LatLng[] = [];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS;
    const mt = 1 - t;
    points.push(
      merc.unproject(
        L.point(
          mt * mt * p1.x + 2 * mt * t * control.x + t * t * p2.x,
          mt * mt * p1.y + 2 * mt * t * control.y + t * t * p2.y,
        ),
      ),
    );
  }
  return points;
}

/**
 * The dotted arc with marching-ants motion, previous → current. Lives *inside*
 * MapContainer so its Polyline ref is populated: the map renders its children
 * only after an init effect sets context, so an effect in the parent would run
 * before the Polyline (and its SVG `_path`) exist.
 */
function AnimatedArc({
  positions,
  color,
}: {
  positions: L.LatLng[];
  color: string;
}) {
  const lineRef = useRef<L.Polyline>(null);
  // March the dashes from the previous address toward the current pin. Driven
  // via the Web Animations API on the SVG path (not a CSS class — a class on
  // Leaflet's <path> drops in the production build), and skipped for reduced
  // motion. Offset decreasing by one dash period moves dots start → end.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const path = (lineRef.current as { _path?: SVGPathElement } | null)?._path;
    const anim = path?.animate(
      { strokeDashoffset: ['0', '-10'] },
      { duration: 600, iterations: Number.POSITIVE_INFINITY, easing: 'linear' },
    );
    return () => anim?.cancel();
  }, []);
  return (
    <Polyline
      ref={lineRef}
      positions={positions}
      pathOptions={{
        color,
        weight: 2.5,
        opacity: 0.9,
        dashArray: '1 9',
        lineCap: 'round',
      }}
    />
  );
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

  const arc = curvedArc(fromLatLng, toLatLng);

  return (
    <MapShell
      // Fit the whole arc, not just the endpoints, so the bow isn't clipped.
      bounds={L.latLngBounds(arc)}
      // Tight fit: fractional zoom (integer zoomSnap rounds the fit a whole
      // level out) + just enough padding for the 42px pin graphic.
      boundsOptions={{
        paddingTopLeft: [24, 52],
        paddingBottomRight: [24, 20],
        maxZoom: 16,
      }}
      zoomSnap={0.25}
    >
      <AnimatedArc
        positions={arc}
        color={isDark ? LINE_COLOR.dark : LINE_COLOR.light}
      />
      <Marker position={fromPos} icon={previousIcon} title="Previous address" />
      <Marker position={toPos} icon={unionJackIcon} title="New address" />
      {/* Beside the current-location pin; non-interactive so it never blocks the map. */}
      <Marker position={toPos} icon={distanceIcon} interactive={false} />
    </MapShell>
  );
}
