import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttributionControl,
  MapContainer,
  Marker,
  TileLayer,
} from 'react-leaflet';
import type { Geocoded } from '../api/geocode';
import { useIsDark } from '../hooks/useIsDark';
import { TILE_MAX_ZOOM, TILE_MIN_ZOOM } from '../utils/tileBounds';
import './LeafletMap.css';
import UnionJackLens from './UnionJackLens';

const LIGHT_TILES = '/api/tiles/alidade_smooth/{z}/{x}/{y}{r}';
const DARK_TILES = '/api/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}';
const TILE_ATTRIBUTION =
  '&copy; <a target="_blank" href="https://leafletjs.com">Leaflet</a> &copy; <a target="_blank" href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a target="_blank" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

const ICON_W = 32;
const ICON_H = 42;

const teardropSvg = `<svg viewBox="0 0 100 130" xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:0;left:0;width:${ICON_W}px;height:${ICON_H}px;">
  <path d="M50 2 C23 2 2 23 2 50 C2 70 25 95 50 128 C75 95 98 70 98 50 C98 23 77 2 50 2 Z" fill="var(--logo-navy)" />
</svg>`;

const lensSvg = renderToStaticMarkup(
  <UnionJackLens
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: ICON_W,
      height: ICON_W,
    }}
  />,
);

const unionJackIcon = L.divIcon({
  html: `<div style="--logo-navy:var(--surface);position:relative;width:${ICON_W}px;height:${ICON_H}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));">${teardropSvg}${lensSvg}</div>`,
  className: '',
  iconSize: [ICON_W, ICON_H],
  iconAnchor: [ICON_W / 2, ICON_H],
});

/** Leaflet map centered on `geo` with a custom Union-Jack-pin marker (teardrop body + the shared `UnionJackLens` overlaid as the head). Tile theme switches with the page's light/dark mode via Stadia Maps `alidade_smooth` / `alidade_smooth_dark`. Loaded client-side only via the `AddressMap` lazy import — Leaflet touches `window`/`document` at import time and can't run on the SSR server. */
export default function LeafletMap({ geo }: { geo: Geocoded }) {
  const position: [number, number] = [geo.lat, geo.lon];
  const isDark = useIsDark();
  return (
    <MapContainer
      center={position}
      zoom={16}
      minZoom={TILE_MIN_ZOOM}
      maxZoom={TILE_MAX_ZOOM}
      scrollWheelZoom={false}
      attributionControl={false}
      className="absolute inset-0 isolate h-full w-full"
    >
      <AttributionControl prefix={false} />
      <TileLayer
        attribution={TILE_ATTRIBUTION}
        url={isDark ? DARK_TILES : LIGHT_TILES}
      />
      <Marker position={position} icon={unionJackIcon} />
    </MapContainer>
  );
}
