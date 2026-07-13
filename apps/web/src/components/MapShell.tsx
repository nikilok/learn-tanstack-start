import 'leaflet/dist/leaflet.css';
import { type ComponentProps } from 'react';
import { AttributionControl, MapContainer } from 'react-leaflet';

import { useIsDark } from '../hooks/useIsDark';
import { TILE_MAX_ZOOM, TILE_MIN_ZOOM } from '../utils/tileBounds';
import { CachedTileLayer } from './CachedTileLayer';

import './LeafletMap.css';

export const LIGHT_TILES = '/api/tiles/alidade_smooth/{z}/{x}/{y}{r}';
export const DARK_TILES = '/api/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}';
export const TILE_ATTRIBUTION =
  '&copy; <a target="_blank" href="https://leafletjs.com">Leaflet</a> &copy; <a target="_blank" href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a target="_blank" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/**
 * Shared Leaflet scaffolding for every company map: zoom clamps, attribution,
 * and the theme-switched Stadia tile layer. Children are the map's markers and
 * shapes; any MapContainer prop can be overridden per map.
 */
export function MapShell({
  children,
  ...mapProps
}: ComponentProps<typeof MapContainer>) {
  const isDark = useIsDark();
  return (
    <MapContainer
      minZoom={TILE_MIN_ZOOM}
      maxZoom={TILE_MAX_ZOOM}
      scrollWheelZoom={false}
      attributionControl={false}
      className="absolute inset-0 isolate h-full w-full"
      {...mapProps}
    >
      <AttributionControl prefix={false} />
      <CachedTileLayer
        attribution={TILE_ATTRIBUTION}
        url={isDark ? DARK_TILES : LIGHT_TILES}
      />
      {children}
    </MapContainer>
  );
}
