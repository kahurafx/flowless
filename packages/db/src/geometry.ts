import { customType } from "drizzle-orm/pg-core";

/**
 * PostGIS geometry columns (G-01), ported from Majimap. Everything is SRID 4326: plain
 * WGS 84 longitude and latitude, unprojected. Z and M values are not supported.
 */
export type LatLng = { lat: number; lng: number };

const Z_FLAG = 0x80000000;
const M_FLAG = 0x40000000;
const SRID_FLAG = 0x20000000;

/**
 * PostGIS returns geometry as hex-encoded EWKB on every read path (select, returning,
 * relational queries), so it is decoded here once and plain queries just work. Byte order
 * is read from the data, so both NDR (little-endian, PostGIS's default) and XDR decode.
 */
class EwkbReader {
  private readonly view: DataView;
  private offset = 0;
  private littleEndian = true;

  constructor(hex: string) {
    if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new Error(`Expected hex-encoded EWKB from PostGIS, got "${hex.slice(0, 40)}"`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    this.view = new DataView(bytes.buffer);
  }

  /** Reads byte order, type and (if present) SRID; returns the base geometry type code. */
  header(): number {
    this.littleEndian = this.view.getUint8(this.offset) === 1;
    this.offset += 1;
    const rawType = this.u32();
    if ((rawType & Z_FLAG) !== 0 || (rawType & M_FLAG) !== 0) {
      throw new Error("Z/M geometries are not supported");
    }
    if ((rawType & SRID_FLAG) !== 0) this.u32();
    return rawType & 0xff;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  private f64(): number {
    const value = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += 8;
    return value;
  }

  point(): LatLng {
    const lng = this.f64();
    const lat = this.f64();
    return { lat, lng };
  }

  points(): LatLng[] {
    const count = this.u32();
    const out: LatLng[] = [];
    for (let i = 0; i < count; i++) out.push(this.point());
    return out;
  }
}

function expectType(actual: number, expected: number, name: string) {
  if (actual !== expected) {
    throw new Error(`Expected a ${name} but PostGIS returned geometry type ${actual}`);
  }
}

export function parsePointEwkb(hex: string): LatLng {
  const reader = new EwkbReader(hex);
  expectType(reader.header(), 1, "Point");
  return reader.point();
}

export function parseLineStringEwkb(hex: string): LatLng[] {
  const reader = new EwkbReader(hex);
  expectType(reader.header(), 2, "LineString");
  return reader.points();
}

/** Outer ring only: polygons with holes are refused rather than silently losing them. */
export function parsePolygonEwkb(hex: string): LatLng[] {
  const reader = new EwkbReader(hex);
  expectType(reader.header(), 3, "Polygon");
  const rings = reader.u32();
  if (rings !== 1) throw new Error(`Polygons with holes aren't supported (got ${rings} rings)`);
  return reader.points();
}

function toPairs(points: LatLng[]) {
  return points.map((p) => `${p.lng} ${p.lat}`).join(", ");
}

function closeRing(ring: LatLng[]): LatLng[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  return first.lat === last.lat && first.lng === last.lng ? ring : [...ring, first];
}

/** `geometry(Point, 4326)`. */
export const pointColumn = customType<{ data: LatLng; driverData: string }>({
  dataType: () => "geometry(Point, 4326)",
  toDriver: (value) => `SRID=4326;POINT(${value.lng} ${value.lat})`,
  fromDriver: (value) => parsePointEwkb(value),
});

/** `geometry(LineString, 4326)`. */
export const lineStringColumn = customType<{ data: LatLng[]; driverData: string }>({
  dataType: () => "geometry(LineString, 4326)",
  toDriver: (path) => `SRID=4326;LINESTRING(${toPairs(path)})`,
  fromDriver: (value) => parseLineStringEwkb(value),
});

/** `geometry(Polygon, 4326)`, always a closed ring: an unclosed one is closed on write. */
export const polygonColumn = customType<{ data: LatLng[]; driverData: string }>({
  dataType: () => "geometry(Polygon, 4326)",
  toDriver: (ring) => `SRID=4326;POLYGON((${toPairs(closeRing(ring))}))`,
  fromDriver: (value) => parsePolygonEwkb(value),
});
