import type { Geocoded } from '../api/geocode';

const BBOX_HALF_EXTENT_METERS = 50;

/** Build a tight bbox around `lat`/`lon` for the OSM embed iframe — half-extent in metres controls zoom (smaller = more zoomed in). */
function tightBbox(lat: number, lon: number): string {
  const latDelta = BBOX_HALF_EXTENT_METERS / 111_000;
  const lonDelta =
    BBOX_HALF_EXTENT_METERS / (111_000 * Math.cos((lat * Math.PI) / 180));
  return [lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta].join(
    ',',
  );
}

/** Embeds an OpenStreetMap iframe centered on `geo` with a marker. Geo is resolved upstream by the route loader so this component renders synchronously. */
export function AddressMap({ geo }: { geo: Geocoded }) {
  const iframeSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${tightBbox(geo.lat, geo.lon)}&layer=mapnik&marker=${geo.lat},${geo.lon}`;

  return (
    <div className="relative h-64 w-full bg-(--sea-ink-soft)/10">
      <iframe
        title="Map of registered address"
        src={iframeSrc}
        className="absolute inset-0 h-full w-full border-0 transition-[filter] duration-200 pointer-fine:saturate-0 pointer-fine:hover:saturate-100 pointer-fine:dark:invert pointer-fine:dark:hue-rotate-180 pointer-fine:dark:hover:invert-0 pointer-fine:dark:hover:hue-rotate-0"
        loading="lazy"
      />
    </div>
  );
}
