export interface Geocoded {
  lat: number;
  lon: number;
}

/** Pull coords out of a Nominatim search response array. Tolerates any hit shape: string or numeric coordinate fields parse, everything else (missing hit, non-object, unparseable or non-finite coords) is null. */
export function parseGeocodeBody(body: readonly unknown[]): Geocoded | null {
  const hit = body[0];
  if (typeof hit !== 'object' || hit === null) return null;
  const { lat, lon } = hit as { lat?: unknown; lon?: unknown };
  const latNum = Number.parseFloat(String(lat));
  const lonNum = Number.parseFloat(String(lon));
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
  return { lat: latNum, lon: lonNum };
}
