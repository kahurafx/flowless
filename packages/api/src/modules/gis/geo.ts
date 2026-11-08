import type { LatLng } from "@flowless/db";

const EARTH_RADIUS_METRES = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance between two points. */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Length along a path, segment by segment. The server computes a pipe's length from its
 * geometry rather than trusting a client-supplied number: a typo'd or stale length would
 * otherwise sit in the data looking authoritative.
 */
export function pathLengthMetres(path: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1];
    const to = path[i];
    if (from && to) total += haversineMetres(from, to);
  }
  return total;
}

/**
 * Whether a ring encloses no area at all: fewer than three distinct corners, or every
 * corner in a line. Planar arithmetic in degrees is fine for this yes/no question, and
 * working relative to the first corner keeps floating-point noise from making a flat ring
 * look like it has area. Doesn't detect a ring that crosses itself.
 */
export function isDegenerateRing(ring: readonly LatLng[]): boolean {
  const first = ring[0];
  if (!first) return true;
  if (new Set(ring.map((p) => `${p.lat},${p.lng}`)).size < 3) return true;

  let twiceArea = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    twiceArea += (a.lng - first.lng) * (b.lat - first.lat) - (b.lng - first.lng) * (a.lat - first.lat);
  }
  return Math.abs(twiceArea) < 1e-12;
}

/** Shared with the apps (@flowless/network), so a DMA's membership check gives the same answer everywhere. */
export { pointInRing } from "@flowless/network";
