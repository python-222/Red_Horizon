/**
 * Pure Martian Jezero Crater & spherical coordinate helpers.
 * Separated from MarsWalkHud so VisorHUD and App can import them without pulling Leaflet into the initial bundle.
 */

export const MARS_RADIUS_KM = 3389.5;
export const JEZERO_ORIGIN = { lat: 18.44, lon: 77.45 };
export const METERS_PER_DEG_LAT = 59274;
export const METERS_PER_DEG_LON = METERS_PER_DEG_LAT * Math.cos((JEZERO_ORIGIN.lat * Math.PI) / 180);

export interface CustomWaypoint {
  id: number;
  lat: number;
  lng: number;
}

export function shortestLngDeltaDeg(fromLng: number, toLng: number): number {
  return ((((toLng - fromLng + 180) % 360) + 360) % 360) - 180;
}

export function normalizeLng180(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

export function jezeroMetersToLatLng(x: number, y: number): [number, number] {
  const lat = Math.max(-90, Math.min(90, JEZERO_ORIGIN.lat + y / METERS_PER_DEG_LAT));
  const lng = normalizeLng180(JEZERO_ORIGIN.lon + x / METERS_PER_DEG_LON);
  return [lat, lng];
}

export function latLngToJezeroMeters(lat: number, lng: number): { x: number; y: number } {
  const dLng = shortestLngDeltaDeg(JEZERO_ORIGIN.lon, lng);
  return {
    y: (lat - JEZERO_ORIGIN.lat) * METERS_PER_DEG_LAT,
    x: dLng * METERS_PER_DEG_LON,
  };
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = shortestLngDeltaDeg(a.lng, b.lng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.max(0, Math.sqrt(Math.max(0, h)))));
}

export function orderWaypointsNearestFirst(
  origin: { lat: number; lng: number },
  list: CustomWaypoint[]
): CustomWaypoint[] {
  if (list.length <= 1) return list;
  const remaining = [...list];
  const ordered: CustomWaypoint[] = [];
  let cursor = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = haversineKm(cursor, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked);
    cursor = picked;
  }
  return ordered;
}
