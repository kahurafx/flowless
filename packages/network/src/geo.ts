/** A position in WGS84 degrees, the same shape as shared-types' Point. */
export type LatLng = { lat: number; lng: number };

/**
 * Whether a point is inside a ring (ray casting). The ring may be open or
 * closed. A point exactly on an edge may land either side, which is fine for
 * its use here: a cross-check between a boundary and what's connected, not a
 * legal survey. Shared so the server's DMA analysis and the apps' agree.
 */
export function pointInRing(point: LatLng, ring: readonly LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (straddles && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

const METRES_PER_DEGREE = 111_320;

/** Metres from a point to a segment, on a flat projection around the point. Plenty accurate over the distances this is used for. */
function distanceToSegmentM(point: LatLng, a: LatLng, b: LatLng): number {
  const scale = Math.cos((point.lat * Math.PI) / 180);
  const ax = (a.lng - point.lng) * scale * METRES_PER_DEGREE;
  const ay = (a.lat - point.lat) * METRES_PER_DEGREE;
  const bx = (b.lng - point.lng) * scale * METRES_PER_DEGREE;
  const by = (b.lat - point.lat) * METRES_PER_DEGREE;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const along = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + along * dx, ay + along * dy);
}

/** Beyond this, a service connection probably isn't on that pipe, or the pipe isn't mapped. A starting value, to tune with real data. */
export const MAX_SERVICE_DISTANCE_M = 50;

/** The pipe most likely serving a point: the closest one within `maxDistanceM`, or null if none is that close. */
export function nearestPipe<P extends { id: string; path: readonly LatLng[] }>(
  point: LatLng,
  pipes: readonly P[],
  maxDistanceM: number = MAX_SERVICE_DISTANCE_M,
): { pipeId: string; distanceM: number } | null {
  let best: { pipeId: string; distanceM: number } | null = null;
  for (const pipe of pipes) {
    for (let i = 1; i < pipe.path.length; i++) {
      const distanceM = distanceToSegmentM(point, pipe.path[i - 1]!, pipe.path[i]!);
      if (distanceM <= maxDistanceM && (!best || distanceM < best.distanceM)) best = { pipeId: pipe.id, distanceM };
    }
  }
  return best;
}
