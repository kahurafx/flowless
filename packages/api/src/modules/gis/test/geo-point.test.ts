import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { pointInRing } from "../geo";

const p = (lat: number, lng: number) => ({ lat, lng });

describe("pointInRing", () => {
  const square = [p(0, 0), p(0, 10), p(10, 10), p(10, 0)];

  it("finds a point inside a square", () => {
    assert.equal(pointInRing(p(5, 5), square), true);
  });

  it("rejects points outside a square, on every side", () => {
    assert.equal(pointInRing(p(15, 5), square), false);
    assert.equal(pointInRing(p(-5, 5), square), false);
    assert.equal(pointInRing(p(5, 15), square), false);
    assert.equal(pointInRing(p(5, -1), square), false);
  });

  it("gives the same answer for a closed ring as an open one", () => {
    const closed = [...square, p(0, 0)];
    for (const point of [p(5, 5), p(15, 5), p(5, -1)]) {
      assert.equal(pointInRing(point, closed), pointInRing(point, square));
    }
  });

  it("understands a concave shape: the notch of an L is outside", () => {
    // Covers latitudes 0–5 across the full width, and 5–10 only for longitudes 0–5.
    const ell = [p(0, 0), p(0, 10), p(5, 10), p(5, 5), p(10, 5), p(10, 0)];
    assert.equal(pointInRing(p(2, 2), ell), true);
    assert.equal(pointInRing(p(2, 8), ell), true, "the foot of the L");
    assert.equal(pointInRing(p(7, 2), ell), true, "the upright of the L");
    assert.equal(pointInRing(p(7, 7), ell), false, "the notch");
  });

  it("says nothing is inside an empty ring", () => {
    assert.equal(pointInRing(p(1, 1), []), false);
  });
});
