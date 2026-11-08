import { describe, expect, it } from "vitest";
import { diffRows } from "./diff";

type Row = { id: string; n: number };
const key = (r: Row) => r.id;

describe("diffRows", () => {
  it("writes only the rows that changed or are new, and removes the ones that are gone", () => {
    const a = { id: "a", n: 1 };
    const b = { id: "b", n: 1 };
    const before = [a, b];
    const next = [a, { ...b, n: 2 }, { id: "c", n: 1 }];
    expect(diffRows(before, next, key)).toEqual({ upserts: [{ id: "b", n: 2 }, { id: "c", n: 1 }], deletes: [] });
    expect(diffRows(before, [a], key)).toEqual({ upserts: [], deletes: ["b"] });
  });

  it("does nothing for the same list", () => {
    const list = [{ id: "a", n: 1 }];
    expect(diffRows(list, list, key)).toEqual({ upserts: [], deletes: [] });
  });
});
