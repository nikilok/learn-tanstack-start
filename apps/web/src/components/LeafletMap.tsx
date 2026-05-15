import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { MapContainer, Marker, TileLayer } from 'react-leaflet';
import type { Geocoded } from '../api/geocode';

const defaultIcon = L.icon({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

/** OSM-tiled Leaflet map centered on `geo`. Loaded client-side only via the `AddressMap` lazy import — Leaflet touches `window`/`document` at import time and can't run on the SSR server. */
export default function LeafletMap({ geo }: { geo: Geocoded }) {
  const position: [number, number] = [geo.lat, geo.lon];
  return (
    <MapContainer
      center={position}
      zoom={16}
      scrollWheelZoom={false}
      className="absolute inset-0 h-full w-full transition-[filter] duration-200 pointer-fine:saturate-0 pointer-fine:hover:saturate-100 pointer-fine:dark:invert pointer-fine:dark:hue-rotate-180 pointer-fine:dark:hover:invert-0 pointer-fine:dark:hover:hue-rotate-0"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={position} icon={defaultIcon} />
    </MapContainer>
  );
}
