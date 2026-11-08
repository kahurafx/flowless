// Dev data for Work Orders and GIS (Phase 2): a small Ruiru network for MAJISAFI and a few jobs.
// Written through the real API as the organization's owner, like the rest of the seed.
import type { createCaller } from "@flowless/api";

type Api = ReturnType<typeof createCaller>;
interface Person {
  id: string;
  /** The username or owner email the member signs in with. */
  who: string;
}

const KAHAWA = { lat: -1.1935, lng: 36.93 };
const at = (dLat: number, dLng: number) => ({ lat: Number((KAHAWA.lat + dLat).toFixed(6)), lng: Number((KAHAWA.lng + dLng).toFixed(6)) });

/**
 * A reservoir feeding DMA Kahawa West 1 through a trunk valve and an inlet meter in a chamber, three
 * junctions, a hydrant, a boundary valve and a stray node beyond it, four connections, and the DMA's
 * boundary on the existing DMA-KW1 area. Skipped when the organization already has nodes.
 */
export async function seedRuiruNetwork(api: Api, areas: ReadonlyMap<string, string>) {
  if ((await api.gis.nodes.list()).length === 0) await seedNodesAndPipes(api);
  if ((await api.gis.dmas.list()).length === 0) await seedDma(api, areas);
}

async function seedNodesAndPipes(api: Api) {
  const chamber = await api.gis.structures.create({ type: "chamber", name: "Chamber C-12", location: at(-0.0005, -0.0025), condition: "fair" });
  await api.gis.structures.create({ type: "manhole", name: "Manhole MH-3", location: at(-0.0015, 0.0015), condition: "good" });

  const node = (type: "reservoir" | "valve" | "meter" | "junction" | "hydrant", name: string, d: [number, number], extra: { isOpen?: boolean; structureId?: string; condition?: "good" | "fair" | "poor" | "critical" } = {}) =>
    api.gis.nodes.create({ type, name, location: at(...d), condition: extra.condition ?? "good", isOpen: type === "valve" ? (extra.isOpen ?? true) : null, structureId: extra.structureId ?? null });

  const reservoir = await node("reservoir", "Ruiru Hill Reservoir", [0.0035, -0.007]);
  const trunk = await node("valve", "Trunk valve TV-1", [0.0025, -0.005]);
  const meter = await node("meter", "KW1 inlet meter", [0.001, -0.0025], { structureId: chamber.id });
  const j1 = await node("junction", "Junction J1", [0, -0.0005]);
  const j2 = await node("junction", "Junction J2", [-0.0015, 0.0015], { condition: "fair" });
  const j3 = await node("junction", "Junction J3", [-0.0005, 0.0035]);
  const hydrant = await node("hydrant", "Hydrant H-01", [-0.0025, 0], { condition: "poor" });
  const boundary = await node("valve", "KW1 boundary valve", [-0.002, 0.0045], { isOpen: false });
  const stray = await node("junction", "Junction J4 (outside DMA)", [-0.004, 0.006]);

  const pipe = (from: { id: string; location: { lat: number; lng: number } }, to: { id: string; location: { lat: number; lng: number } }, diameterMm: number, material: "pvc" | "ductile_iron" | "hdpe", condition: "good" | "fair" | "poor" = "good", bend?: { lat: number; lng: number }) =>
    api.gis.pipes.create({
      fromNodeId: from.id,
      toNodeId: to.id,
      path: [from.location, ...(bend ? [bend] : []), to.location],
      diameterMm,
      material,
      condition,
    });
  await pipe(reservoir, trunk, 250, "ductile_iron");
  await pipe(trunk, meter, 250, "ductile_iron");
  await pipe(meter, j1, 200, "ductile_iron", "good", at(0.0008, -0.0015));
  const main = await pipe(j1, j2, 150, "pvc", "poor");
  const second = await pipe(j2, j3, 150, "pvc");
  await pipe(j1, hydrant, 100, "pvc");
  await pipe(j3, boundary, 150, "pvc");
  await pipe(boundary, stray, 150, "pvc");

  const connection = (connectionNumber: string, d: [number, number], pipeId: string) => api.gis.connections.create({ connectionNumber, location: at(...d), pipeId });
  await connection("KW-0001", [-0.0007, 0.0004], main.id);
  await connection("KW-0002", [-0.0009, 0.0011], main.id);
  await connection("KW-0003", [-0.001, 0.0027], second.id);
  await connection("KW-0004", [-0.0003, 0.0021], second.id);

}

/** DMA Kahawa West 1's boundary, with the inlet meter and boundary valve seeded above. */
async function seedDma(api: Api, areas: ReadonlyMap<string, string>) {
  const dmaArea = areas.get("DMA-KW1");
  if (!dmaArea) throw new Error("DMA-KW1 is missing: seed the areas first");
  // A DMA someone archived while testing the hierarchy can't take map data until it is back.
  const all = await api.hierarchy.areas({ includeArchived: true });
  const chain: typeof all = [];
  for (let a = all.find((x) => x.id === dmaArea); a; a = all.find((x) => x.id === a!.parentId)) chain.unshift(a);
  for (const a of chain) if (a.archivedAt) await api.hierarchy.restoreArea({ id: a.id });
  const nodes = await api.gis.nodes.list();
  const meter = nodes.find((n) => n.name === "KW1 inlet meter");
  const boundary = nodes.find((n) => n.name === "KW1 boundary valve");
  if (!meter || !boundary) throw new Error("The Ruiru network nodes are missing");

  const tiers = await api.gis.tiers.list();
  const tierId = tiers.find((t) => t.name === "DMA")?.id ?? (await createTiers(api));
  await api.gis.dmas.create({
    areaId: dmaArea,
    color: "#3b82f6",
    tierId,
    inletMeterId: meter.id,
    boundaryValveIds: [boundary.id],
    ring: [at(0.0015, -0.0035), at(0.0015, 0.0047), at(-0.0032, 0.0047), at(-0.0032, -0.0035)],
  });
}

/** Transmission, distribution and DMA tiers, top of the hierarchy first; returns the DMA tier's id. */
async function createTiers(api: Api): Promise<string> {
  const existing = new Map((await api.gis.tiers.list()).map((t) => [t.name, t.id]));
  for (const [name, order] of [["Transmission", 1], ["Distribution", 2], ["DMA", 3]] as const) {
    if (!existing.has(name)) existing.set(name, (await api.gis.tiers.create({ name, order })).id);
  }
  return existing.get("DMA")!;
}

/** A handful of jobs in different states: assigned, unassigned, overdue and one waiting for review. */
export async function seedJobs(api: Api, areas: ReadonlyMap<string, string>, people: readonly Person[]) {
  const existing = new Set((await api.workOrders.list({ limit: 200 })).map((j) => j.title));
  const juma = people.find((p) => p.who === "juma")?.id ?? null;
  const owner = people.find((p) => p.who.includes("@") && !p.who.includes(".invalid"))?.id ?? null;
  const [nodes, pipes] = await Promise.all([api.gis.nodes.list(), api.gis.pipes.list()]);
  const named = (name: string) => nodes.find((n) => n.name === name)?.id ?? null;
  const day = 86_400_000;

  const make = async (input: Parameters<Api["workOrders"]["create"]>[0]) => (existing.has(input.title) ? null : api.workOrders.create(input));

  const worst = pipes.find((p) => p.condition === "poor");
  await make({ title: "Repair leak on the Kahawa West main", description: "Reported by a resident near plot 14.", kind: "repair", priority: "high", assetId: worst?.id ?? null, areaId: areas.get("KW") ?? null, assigneeId: juma });
  await make({
    title: "Exercise Kahawa West valves",
    kind: "valve_exercise",
    priority: "normal",
    assetId: named("Trunk valve TV-1"),
    relatedAssetIds: named("KW1 boundary valve") ? [named("KW1 boundary valve")!] : [],
    assigneeId: juma,
    dueAt: new Date(Date.now() + 5 * day),
  });
  await make({ title: "Capture the new hydrant at Githurai 45", kind: "asset_capture", location: { latitude: -1.2012, longitude: 36.9194 }, locationNote: "Opposite the market gate", assigneeId: juma, areaId: areas.get("G45") ?? null });
  await make({ title: "Flush the Kahawa West dead ends", kind: "flushing", assetId: named("Hydrant H-01"), dueAt: new Date(Date.now() - 2 * day), assigneeId: juma });
  await make({ title: "Condition assessment of Chamber C-12", kind: "inspection", priority: "low" });

  if (owner && !existing.has("Survey Kahawa West Phase 2 pressures")) {
    const survey = await api.workOrders.create({ title: "Survey Kahawa West Phase 2 pressures", kind: "survey", areaId: areas.get("KW-P2") ?? null, assigneeId: owner });
    await api.workOrders.transition({
      eventId: crypto.randomUUID(),
      workOrderId: survey.id,
      action: { type: "submit", outcome: "done", note: "Readings at 6 points.", capture: { summary: "Pressure holds above 1.5 bar at every point except the far end of J3." } },
    });
  }
}
