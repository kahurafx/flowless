import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { haversineMetres, pathLengthMetres } from "../geo";

const origin = { lat: 0, lng: 0 };

describe("haversineMetres", () => {
  it("is zero between a point and itself", () => {
    assert.equal(haversineMetres(origin, origin), 0);
  });

  it("puts one degree of latitude at about 111.2 km", () => {
    const metres = haversineMetres(origin, { lat: 1, lng: 0 });
    assert.ok(Math.abs(metres - 111_195) < 5, `got ${metres}`);
  });

  it("measures a degree of longitude the same at the equator", () => {
    const metres = haversineMetres(origin, { lat: 0, lng: 1 });
    assert.ok(Math.abs(metres - 111_195) < 5, `got ${metres}`);
  });

  it("shrinks a degree of longitude toward the poles (about half at 60°)", () => {
    const metres = haversineMetres({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    assert.ok(Math.abs(metres - 55_597) < 20, `got ${metres}`);
  });

  it("gives the same distance in either direction", () => {
    const a = { lat: -1.2921, lng: 36.8219 };
    const b = { lat: -1.3, lng: 36.79 };
    assert.ok(Math.abs(haversineMetres(a, b) - haversineMetres(b, a)) < 1e-6);
  });
});

describe("pathLengthMetres", () => {
  it("is zero for fewer than two points", () => {
    assert.equal(pathLengthMetres([]), 0);
    assert.equal(pathLengthMetres([origin]), 0);
  });

  it("adds up the segments", () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.01, lng: 0 };
    const c = { lat: 0.01, lng: 0.01 };
    assert.equal(pathLengthMetres([a, b, c]), haversineMetres(a, b) + haversineMetres(b, c));
  });

  it("counts a path that doubles back both ways", () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.01, lng: 0 };
    assert.ok(Math.abs(pathLengthMetres([a, b, a]) - 2 * haversineMetres(a, b)) < 1e-6);
  });
});
