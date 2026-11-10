import { describe, expect, it } from "vitest";
import { checkMeterChange } from "./meter-change";
import { afterMeterChange, afterVisit, assembleTasks, baselineOf, checkVisit, cleanTags, countByState, inChunks, latestPerRoute, orderTasks, searchTasks, type RoundTask } from "./readings";
import { meterChangeOps, readingOps, visitOps, type UploadSpec } from "./sync/build";
import type { Op, SyncItem } from "./sync/ops";
import { runQueue } from "./sync/queue";

const DAY = 86_400_000;
const NOW = new Date("2026-03-01T08:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

const task = (over: Partial<RoundTask> = {}): RoundTask => ({
  id: "s1:sp1",
  snapshotId: "s1",
  routeId: "r1",
  cycleDate: "2026-03-01",
  servicePointId: "sp1",
  accountId: "a1",
  accountNumber: "A-100",
  meterId: "m1",
  walkingSequence: null,
  state: "to_read",
  lastOutcome: null,
  meter: { serial: "KW-001", dialDigits: 5 },
  previous: { value: 100, readAt: ago(30) },
  history: [{ value: 70, readAt: ago(60) }],
  ...over,
});

describe("ordering and search", () => {
  it("orders by walking sequence, unsequenced last, then account number", () => {
    const list = [task({ servicePointId: "c", accountNumber: "A-10" }), task({ servicePointId: "b", walkingSequence: 2 }), task({ servicePointId: "a", walkingSequence: 1 }), task({ servicePointId: "d", accountNumber: "A-9" })];
    expect(orderTasks(list).map((t) => t.servicePointId)).toEqual(["a", "b", "d", "c"]);
  });
  it("searches account, serial and service point prefix", () => {
    const list = [task(), task({ servicePointId: "zz9", accountNumber: "B-7", meter: { serial: "XY-5", dialDigits: 5 } })];
    expect(searchTasks(list, "b-7")).toHaveLength(1);
    expect(searchTasks(list, "xy")).toHaveLength(1);
    expect(searchTasks(list, "zz")).toHaveLength(1);
    expect(searchTasks(list, "  ")).toHaveLength(2);
    expect(searchTasks(list, "nope")).toHaveLength(0);
  });
  it("counts states and keeps the newest snapshot of each route", () => {
    expect(countByState([task(), task({ state: "read" }), task({ state: "missed" }), task({ state: "read" })])).toEqual({ to_read: 1, read: 2, missed: 1 });
    const heads = [
      { routeId: "r1", cycleDate: "2026-02-01", takenAt: ago(30) },
      { routeId: "r1", cycleDate: "2026-03-01", takenAt: ago(1) },
      { routeId: "r2", cycleDate: "2026-02-15", takenAt: ago(10) },
    ];
    expect(latestPerRoute(heads, 5).map((h) => h.cycleDate)).toEqual(["2026-03-01", "2026-02-15"]);
    expect(latestPerRoute(heads, 1)).toHaveLength(1);
  });
});

describe("baseline from cached readings", () => {
  const r = (over: object) => ({ meterId: "m1", value: 0, readAt: ago(1), kind: "actual", status: "valid", cleared: true, ...over });
  it("takes the newest valid, cleared, actual reading of the meter, and the rest as history", () => {
    const b = baselineOf("m1", [
      r({ value: 50, readAt: ago(90) }),
      r({ value: 90, readAt: ago(30) }),
      r({ value: 999, readAt: ago(5), cleared: false }),
      r({ value: 998, readAt: ago(4), kind: "estimate" }),
      r({ value: 997, readAt: ago(3), status: "voided" }),
      r({ value: 996, readAt: ago(2), meterId: "other" }),
      r({ value: 70, readAt: ago(60) }),
    ]);
    expect(b.previous?.value).toBe(90);
    expect(b.history.map((h) => h.value)).toEqual([70, 50]);
  });
  it("assembles tasks with meter and baseline", () => {
    const out = assembleTasks(
      { id: "s1", routeId: "r1", cycleDate: "2026-03-01" },
      [
        { accountId: "a1", accountNumber: "A-1", servicePointId: "sp1", routeId: "r1", meterId: "m1", walkingSequence: 3, state: "missed", lastAttempt: { outcome: "locked_premises" } },
        { accountId: "a2", servicePointId: "sp2", routeId: "r1", meterId: null, walkingSequence: null, state: "to_read", lastAttempt: null },
      ],
      new Map([["m1", { serial: "KW-1", dialDigits: 6 }]]),
      new Map([["m1", [r({ value: 40 })]]]),
    );
    expect(out[0]).toMatchObject({ id: "s1:sp1", state: "missed", lastOutcome: "locked_premises", meter: { serial: "KW-1", dialDigits: 6 }, previous: { value: 40 } });
    expect(out[1]).toMatchObject({ accountNumber: null, meter: null, previous: null });
  });
  it("runs lookups in chunks", async () => {
    let live = 0;
    let peak = 0;
    const out = await inChunks([1, 2, 3, 4, 5], 2, async (n) => {
      peak = Math.max(peak, ++live);
      await Promise.resolve();
      live--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("checkVisit (M-05, M-07 at entry)", () => {
  it("refuses non-digits, too many digits and a missing meter", () => {
    expect(checkVisit(task(), "12a", NOW, false)).toMatchObject({ ok: false });
    expect(checkVisit(task(), "123456", NOW, false)).toMatchObject({ ok: false });
    expect(checkVisit(task({ meter: null }), "120", NOW, false)).toMatchObject({ ok: false });
  });
  it("passes a normal reading with a range hint", () => {
    const c = checkVisit(task(), "130", NOW, false);
    expect(c).toMatchObject({ ok: true, value: 130, blocking: [], advisory: [], needsRolloverConfirmation: false });
    expect(c.ok && c.result.units).toBe(30);
    expect(c.ok && c.hint?.max).toBe(100 + 90);
  });
  it("separates blocking from advisory flags", () => {
    expect(checkVisit(task(), "100", NOW, false)).toMatchObject({ ok: true, blocking: [], advisory: ["ZERO_CONSUMPTION"] });
    expect(checkVisit(task(), "900", NOW, false)).toMatchObject({ ok: true, blocking: ["ABOVE_RANGE"] });
    expect(checkVisit(task(), "0", NOW, false)).toMatchObject({ ok: true, blocking: expect.arrayContaining(["ZERO"]) });
  });
  it("asks for rollover confirmation only for a plausible wrap, and counts the wrap once confirmed", () => {
    const high = task({ previous: { value: 99_950, readAt: ago(30) }, history: [] });
    const ask = checkVisit(high, "20", NOW, false);
    expect(ask).toMatchObject({ ok: true, needsRolloverConfirmation: true });
    const done = checkVisit(high, "20", NOW, true);
    expect(done).toMatchObject({ ok: true, needsRolloverConfirmation: false, blocking: [] });
    expect(done.ok && done.result).toMatchObject({ units: 70, rollover: true });
    expect(checkVisit(task({ previous: { value: 40_000, readAt: ago(30) } }), "100", NOW, false)).toMatchObject({ blocking: ["BELOW_LAST"], needsRolloverConfirmation: false });
  });
  it("flags a second reading on the same day", () => {
    expect(checkVisit(task({ previous: { value: 100, readAt: new Date(NOW.getTime() - 1000) } }), "105", NOW, false)).toMatchObject({ blocking: expect.arrayContaining(["SAME_DAY_DUPLICATE"]) });
  });
});

describe("local effects", () => {
  it("a visit marks the task read or missed and unsent", () => {
    expect(afterVisit(task(), "read_ok")).toMatchObject({ state: "read", lastOutcome: "read_ok", pending: true });
    expect(afterVisit(task(), "locked_premises")).toMatchObject({ state: "missed", lastOutcome: "locked_premises", pending: true });
  });
  it("a meter change moves the baseline to the new meter's first reading", () => {
    const t = afterMeterChange(task(), { id: "m2", serial: "KW-002", dialDigits: 6 }, { value: 3, readAt: NOW });
    expect(t).toMatchObject({ meterId: "m2", meter: { serial: "KW-002", dialDigits: 6 }, previous: { value: 3 }, history: [] });
  });
  it("cleans tags: trimmed, unique, at most twelve", () => {
    expect(cleanTags([" dog ", "dog", "", "gate"])).toEqual(["dog", "gate"]);
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
  });
});

describe("checkMeterChange (M-07)", () => {
  const t = task();
  const go = (f: string, i: string, reason = "stopped", rollover = false, meter: { dialDigits: number } | null = { dialDigits: 5 }) => checkMeterChange(t, meter, f, rollover, i, reason, NOW);
  it("needs a final reading, a new meter, its first reading and a reason", () => {
    expect(go("150", "0")).toMatchObject({ ok: true, finalValue: 150, initialValue: 0 });
    expect(go("", "0").ok).toBe(false);
    expect(go("150", "").ok).toBe(false);
    expect(go("150", "0", " ").ok).toBe(false);
    expect(go("150", "0", "x", false, null).ok).toBe(false);
  });
  it("final below last must be a confirmed wrap; the new meter's reading fits its own dial", () => {
    const high = { ...t, previous: { value: 99_950, readAt: ago(30) } };
    expect(checkMeterChange(high, { dialDigits: 5 }, "20", false, "0", "r", NOW)).toMatchObject({ ok: false, finalNeedsRollover: true });
    expect(checkMeterChange(high, { dialDigits: 5 }, "20", true, "0", "r", NOW).ok).toBe(true);
    expect(checkMeterChange({ ...t, previous: { value: 40_000, readAt: ago(30) } }, { dialDigits: 5 }, "100", false, "0", "r", NOW)).toMatchObject({ ok: false });
    expect(go("150", "123456")).toMatchObject({ ok: false, initialError: expect.any(String) });
  });
});

describe("op construction", () => {
  const photo: UploadSpec = { id: "f1", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, path: "attachments/a.jpg" };
  const spec = (over = {}) => ({ attemptId: "at1", servicePointId: "sp1", outcome: "read_ok" as const, tags: [], note: "", attemptedAt: NOW.toISOString(), cycleDate: "2026-03-01", reading: { id: "rd1", value: 130, quality: "good" as const, rolloverConfirmed: false }, files: [photo], ...over });

  it("a read visit records the attempt with the reading first, then uploads to the reading", () => {
    const ops = visitOps(spec());
    expect(ops.map((o) => o.proc)).toEqual(["metering.attempts.record", "files.upload"]);
    expect(ops[0]).toMatchObject({ input: { id: "at1", outcome: "read_ok", photoFileId: "f1", cycleDate: "2026-03-01", reading: { id: "rd1", value: 130, readAt: NOW.toISOString() } } });
    expect(ops[1]).toMatchObject({ input: { id: "f1", subjectKind: "reading", subjectId: "rd1" } });
  });
  it("a miss carries no reading and no photo", () => {
    const ops = visitOps(spec({ outcome: "locked_premises", reading: undefined, tags: ["dog"] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ input: { outcome: "locked_premises", tags: ["dog"] } });
    expect((ops[0] as Extract<Op, { proc: "metering.attempts.record" }>).input.reading).toBeUndefined();
    expect((ops[0] as Extract<Op, { proc: "metering.attempts.record" }>).input.photoFileId).toBeUndefined();
  });
  it("a standalone reading and a meter change keep their ids and order", () => {
    const r = readingOps({ id: "rd2", meterId: "m1", value: 5, readAt: NOW.toISOString(), source: "technician", quality: "good", note: "", rolloverConfirmed: false }, [photo]);
    expect(r.map((o) => o.proc)).toEqual(["metering.readings.record", "files.upload"]);
    expect(r[0]).toMatchObject({ input: { id: "rd2", photoFileId: "f1" } });
    const m = meterChangeOps({ id: "mc1", oldMeterId: "m1", newMeterId: "m2", replacedAt: NOW.toISOString(), reason: "stopped", final: { id: "fin", value: 150, rolloverConfirmed: false }, initial: { id: "ini", value: 0 }, files: [photo] });
    expect(m[0]).toMatchObject({ proc: "metering.installations.replace", input: { id: "mc1", finalReading: { id: "fin", photoFileId: "f1" }, initialReading: { id: "ini", value: 0 } } });
    expect(m[1]).toMatchObject({ input: { subjectKind: "reading", subjectId: "fin" } });
  });
});

describe("sync of readings", () => {
  const item = (id: string, ops: Op[]): SyncItem => ({ id, kind: "reading", assetId: null, title: id, assetName: "", detail: "", at: NOW.toISOString(), status: "queued", ops });
  const ops = visitOps({ attemptId: "at1", servicePointId: "sp1", outcome: "read_ok", tags: [], note: "", attemptedAt: NOW.toISOString(), reading: { id: "rd1", value: 130, quality: "good", rolloverConfirmed: false }, files: [] });

  it("a retried item resends the same ids and the server answers replayed", async () => {
    const seen = new Set<string>();
    const sent: string[] = [];
    const transport = {
      async send(op: Op) {
        const id = (op.input as { id: string }).id;
        sent.push(id);
        if (seen.has(id)) return { outcome: "replayed" as const };
        seen.add(id);
        return { outcome: "applied" as const };
      },
    };
    const updates: Record<string, string> = {};
    await runQueue([item("i1", ops)], transport, (id, p) => (updates[id] = p.status));
    await runQueue([item("i1", ops)], transport, (id, p) => (updates[id] = p.status));
    expect(sent).toEqual(["at1", "at1"]);
    expect(updates.i1).toBe("replayed");
  });
  it("offline stops the run and keeps the item failed; a held reading shows its reasons", async () => {
    const offline = { send: async (): Promise<never> => Promise.reject(new Error("offline")) };
    const u1: Record<string, { status: string; error?: string }> = {};
    const run = await runQueue([item("i1", ops)], offline, (id, p) => (u1[id] = p));
    expect(run.stoppedAt).toBe("i1");
    expect(u1.i1).toMatchObject({ status: "failed", error: "offline" });
    const held = { send: async () => ({ outcome: "stale" as const, reason: "Held for review: Reading is zero" }) };
    const u2: Record<string, { status: string; error?: string }> = {};
    const run2 = await runQueue([item("i2", ops)], held, (id, p) => (u2[id] = p));
    expect(run2.refused).toBe(true);
    expect(u2.i2).toMatchObject({ status: "stale", error: "Held for review: Reading is zero" });
  });
  it("a refused attempt is rejected with the server's reason and later items still go", async () => {
    const t = { send: async (op: Op) => ((op.input as { id: string }).id === "at1" ? { outcome: "rejected" as const, reason: "No meter" } : { outcome: "applied" as const }) };
    const out: Record<string, string> = {};
    await runQueue([item("bad", ops), item("ok", [{ ...ops[0]!, input: { ...(ops[0] as Extract<Op, { proc: "metering.attempts.record" }>).input, id: "at2" } } as Op])], t, (id, p) => (out[id] = p.status));
    expect(out).toEqual({ bad: "rejected", ok: "applied" });
  });
});
