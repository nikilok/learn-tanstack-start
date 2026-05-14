import { useEffect, useState } from 'react';

interface Geocoded {
  lat: number;
  lon: number;
}

const cache = new Map<string, Geocoded | null>();

const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/i;

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

/** Prefer a UK postcode when present — Nominatim matches postcodes reliably but chokes on verbose building-name prefixes in Companies House addresses. */
function buildQuery(address: string): string {
  const m = address.match(UK_POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}` : address;
}

/** Geocode an address via Nominatim. Returns `null` for misses, rate-limits, or errors; results cached in-memory by address. */
async function geocode(
  address: string,
  signal: AbortSignal,
): Promise<Geocoded | null> {
  if (cache.has(address)) return cache.get(address) ?? null;
  try {
    const query = buildQuery(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      cache.set(address, null);
      return null;
    }
    const data: Array<{ lat: string; lon: string }> = await res.json();
    const hit = data[0];
    if (!hit) {
      cache.set(address, null);
      return null;
    }
    const result: Geocoded = {
      lat: Number.parseFloat(hit.lat),
      lon: Number.parseFloat(hit.lon),
    };
    cache.set(address, result);
    return result;
  } catch {
    return null;
  }
}

/** Embeds an OpenStreetMap iframe centered on `address` with a marker and an "Open in Maps" link. */
export function AddressMap({ address }: { address: string }) {
  const [geo, setGeo] = useState<Geocoded | null>(null);

  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    geocode(address, controller.signal).then((result) => {
      if (!controller.signal.aborted) setGeo(result);
    });
    return () => controller.abort();
  }, [address]);

  if (!address) return null;

  const iframeSrc = geo
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${tightBbox(geo.lat, geo.lon)}&layer=mapnik&marker=${geo.lat},${geo.lon}`
    : null;

  return (
    <div className="relative h-64 w-full bg-(--sea-ink-soft)/10">
      {iframeSrc && (
        <iframe
          title="Map of registered address"
          src={iframeSrc}
          className="absolute inset-0 h-full w-full border-0 saturate-0 dark:invert dark:hue-rotate-180"
          loading="lazy"
        />
      )}
    </div>
  );
}
