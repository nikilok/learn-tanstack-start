import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapContainer, Marker, TileLayer } from 'react-leaflet';
import type { Geocoded } from '../api/geocode';
import UnionJackLens from './UnionJackLens';

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
  html: `<div style="--logo-navy:var(--logo-red);position:relative;width:${ICON_W}px;height:${ICON_H}px;">${teardropSvg}${lensSvg}</div>`,
  className: '',
  iconSize: [ICON_W, ICON_H],
  iconAnchor: [ICON_W / 2, ICON_H],
});

/** OSM-tiled Leaflet map centered on `geo` with a custom Union-Jack-pin marker (teardrop body + the shared `UnionJackLens` overlaid as the head). Loaded client-side only via the `AddressMap` lazy import — Leaflet touches `window`/`document` at import time and can't run on the SSR server. */
export default function LeafletMap({ geo }: { geo: Geocoded }) {
  const position: [number, number] = [geo.lat, geo.lon];
  return (
    <MapContainer
      center={position}
      zoom={17}
      scrollWheelZoom={false}
      className="absolute inset-0 h-full w-full transition-[filter] duration-200 pointer-fine:saturate-0 pointer-fine:hover:saturate-100 pointer-fine:dark:invert pointer-fine:dark:hue-rotate-180 pointer-fine:dark:hover:invert-0 pointer-fine:dark:hover:hue-rotate-0"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={position} icon={unionJackIcon} />
    </MapContainer>
  );
}
