import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isDegenerateRing } from "../geo";

const p = (lat: number, lng: number) => ({ lat, lng });

describe("isDegenerateRing", () => {
  it("accepts a triangle", () => {
    assert.equal(isDegenerateRing([p(0, 0), p(0, 1), p(1, 0)]), false);
  });

  it("accepts a square, closed or not", () => {
    const corners = [p(0, 0), p(0, 1), p(1, 1), p(1, 0)];
    assert.equal(isDegenerateRing(corners), false);
    assert.equal(isDegenerateRing([...corners, p(0, 0)]), false);
  });

  it("accepts a small but real area, about a hundred metres across", () => {
    assert.equal(isDegenerateRing([p(-1.29, 36.78), p(-1.291, 36.78), p(-1.291, 36.781)]), false);
  });

  it("rejects an empty ring and fewer than three points", () => {
    assert.equal(isDegenerateRing([]), true);
    assert.equal(isDegenerateRing([p(0, 0)]), true);
    assert.equal(isDegenerateRing([p(0, 0), p(1, 1)]), true);
  });

  it("rejects a ring with fewer than three distinct corners", () => {
    assert.equal(isDegenerateRing([p(0, 0), p(0, 0), p(1, 1)]), true);
  });

  it("rejects corners that all lie on one line", () => {
    assert.equal(isDegenerateRing([p(0, 0), p(1, 1), p(2, 2)]), true);
    assert.equal(isDegenerateRing([p(-1.29, 36.78), p(-1.3, 36.78), p(-1.31, 36.78)]), true);
  });
});
