export interface Geocoded {
  lat: number;
  lon: number;
}

/** Parse one coordinate field. Accepts finite string or number values within `limit` degrees of zero; blank strings, partial numerics ("51.5junk"), non-finite and out-of-range values are null. */
function parseCoordinate(value: unknown, limit: number): number | null {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) && Math.abs(num) <= limit ? num : null;
}

/** Pull coords out of a Nominatim search response array. Tolerates any hit shape: finite in-range string or numeric coordinate fields parse, everything else (missing hit, non-object, malformed or out-of-range coords) is null. */
export function parseGeocodeBody(body: readonly unknown[]): Geocoded | null {
  const hit = body[0];
  if (typeof hit !== 'object' || hit === null) return null;
  const { lat, lon } = hit as { lat?: unknown; lon?: unknown };
  const latNum = parseCoordinate(lat, 90);
  const lonNum = parseCoordinate(lon, 180);
  if (latNum === null || lonNum === null) return null;
  return { lat: latNum, lon: lonNum };
}
