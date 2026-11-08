import { describe, expect, it } from "vitest";
import { traceIsolation } from "./isolation";
import { ids, line, twoValves } from "./test-fixtures";

describe("traceIsolation", () => {
  it("returns an empty result for a pipe that doesn't exist", () => {
    const { nodes, pipes } = line();
    expect(traceIsolation("nope", nodes, pipes)).toStrictEqual({
      affectedNodes: [],
      valvesToClose: [],
      alreadyClosed: [],
      unisolatedSources: [],
    });
  });

  it("stops at the open valve beside the break and reports what's cut off", () => {
    const { nodes, pipes } = line(true);
    const result = traceIsolation("p3", nodes, pipes); // the pipe between V and B
    expect(ids(result.valvesToClose)).toStrictEqual(["V"]);
    expect(ids(result.affectedNodes)).toStrictEqual(["B", "C"]);
    expect(result.alreadyClosed).toStrictEqual([]);
  });

  it("doesn't treat a dead-end customer meter as an isolation problem", () => {
    const { nodes, pipes } = line(true);
    const result = traceIsolation("p3", nodes, pipes);
    expect(ids(result.affectedNodes).includes("C"), "the meter loses supply").toBeTruthy();
    expect(result.unisolatedSources, "but a leaf meter is not a failure to isolate").toStrictEqual([]);
  });

  it("lists an already-closed valve as a boundary, not as something to close", () => {
    const { nodes, pipes } = line(false);
    const result = traceIsolation("p3", nodes, pipes);
    expect(result.valvesToClose).toStrictEqual([]);
    expect(ids(result.alreadyClosed)).toStrictEqual(["V"]);
    expect(ids(result.affectedNodes)).toStrictEqual(["B", "C"]);
  });

  it("flags a break that's connected to a supply source with no valve in between", () => {
    const { nodes, pipes } = line(true);
    const result = traceIsolation("p2", nodes, pipes); // between A and V; A connects straight back to R
    expect(ids(result.unisolatedSources)).toStrictEqual(["R"]);
    expect(ids(result.valvesToClose)).toStrictEqual(["V"]);
    expect(ids(result.affectedNodes)).toStrictEqual(["A", "R"]);
  });

  it("flags a break on the pipe directly attached to a source", () => {
    const { nodes, pipes } = twoValves();
    const result = traceIsolation("q1", nodes, pipes); // between R and V1
    expect(ids(result.unisolatedSources)).toStrictEqual(["R"]);
    expect(ids(result.valvesToClose)).toStrictEqual(["V1"]);
    expect(ids(result.affectedNodes)).toStrictEqual(["R"]);
  });

  it("closes the valves on both sides of a break between two valves", () => {
    const { nodes, pipes } = twoValves();
    const result = traceIsolation("q2", nodes, pipes); // between V1 and A
    expect(ids(result.valvesToClose)).toStrictEqual(["V1", "V2"]);
    expect(ids(result.affectedNodes)).toStrictEqual(["A"]);
    expect(result.unisolatedSources).toStrictEqual([]);
  });

  it("routes around a valve that won't operate to the next one beyond it", () => {
    const { nodes, pipes } = twoValves();
    const result = traceIsolation("q2", nodes, pipes, ["V2"]);
    expect(ids(result.valvesToClose)).toStrictEqual(["V1"]);
    // V2 is now inside the affected area, along with everything past it.
    expect(ids(result.affectedNodes)).toStrictEqual(["A", "B", "C", "V2"]);
  });

  it("lets a closed valve stop the trace whether or not it was marked as skipped", () => {
    const { nodes, pipes } = twoValves(true, false);
    for (const skip of [[], ["V2"]]) {
      const result = traceIsolation("q2", nodes, pipes, skip);
      expect(ids(result.valvesToClose)).toStrictEqual(["V1"]);
      expect(ids(result.alreadyClosed)).toStrictEqual(["V2"]);
      expect(ids(result.affectedNodes)).toStrictEqual(["A"]);
    }
  });

  it("returns the caller's own node objects, not copies", () => {
    const { nodes, pipes } = line(true);
    const result = traceIsolation("p3", nodes, pipes);
    expect(result.valvesToClose[0]).toBe(nodes.find((n) => n.id === "V"));
  });
});
