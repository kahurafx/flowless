"use server";

import { METER_KINDS, METER_STATUSES, READING_QUALITIES, type MeterKind, type MeterStatus } from "@flowless/shared-types";
import { orNull } from "@/data/accounts";
import { billingAction } from "@/data/billing-run";
import { getApi } from "@/data/session";
import { instantFromLocal, parseDial, REMOVE_TARGETS } from "@/lib/metering-view";
import { optionalText } from "@/lib/optional-text";

/*
 * Server actions for the meter register, readings, rounds and handovers (M-01 to M-12). Each
 * command carries the id its dialog minted, so a retried submit replays. Dates arrive as ISO
 * instants made in the browser (the browser's own clock and zone). The procedures check licence,
 * permission and scope; a refusal is the dialog's message.
 */

const quality = (q: string) => READING_QUALITIES.find((x) => x === q) ?? "good";
const at = (iso: string) => instantFromLocal(iso);

export async function registerMeterAction(input: { id: string; serial: string; model: string; dialDigits: string; status: "procured" | "in_stock"; kind: string; dmaId: string; note: string }) {
  const digits = Number(input.dialDigits);
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) return { error: "Dial digits: a whole number from 1 to 12" } as const;
  const kind: MeterKind = METER_KINDS.find((k) => k === input.kind) ?? "customer";
  if (kind !== "customer" && !input.dmaId) return { error: "A bulk or master meter measures a DMA: choose one" } as const;
  return billingAction((api) =>
    api.metering.meters
      .register({ id: input.id, serial: input.serial.trim(), dialDigits: digits, status: input.status, kind, ...(kind !== "customer" && input.dmaId ? { dmaId: input.dmaId } : {}), ...optionalText("model", input.model), ...optionalText("note", input.note) })
      .then((m) => ({ id: m.meter.id })),
  );
}

export async function changeMeterStatusAction(input: { id: string; meterId: string; to: string; reason: string }) {
  const to: MeterStatus | undefined = METER_STATUSES.find((s) => s === input.to);
  if (!to) return { error: "Choose a status" } as const;
  return billingAction((api) => api.metering.meters.changeStatus({ id: input.id, meterId: input.meterId, to, reason: input.reason.trim() }).then(() => null));
}

/** Finds a meter by its exact serial (case ignored), for forms that pick a second meter. */
export async function findMeterBySerialAction(serial: string) {
  const text = serial.trim();
  if (!text) return { error: "Type the meter's serial number" } as const;
  const { api } = await getApi();
  const { meters } = await api.metering.meters.list({ search: text, limit: 20 });
  const found = meters.find((m) => m.serial.toLowerCase() === text.toLowerCase());
  if (!found) return { error: `No meter with serial ${text}` } as const;
  return { error: null, data: { id: found.id, serial: found.serial, dialDigits: found.dialDigits, status: found.status } } as const;
}

/** The service points of an account, for choosing where to install a meter. */
export async function servicePointsOfAccountAction(number: string) {
  const text = number.trim();
  if (!text) return { error: "Type the account number" } as const;
  const { api } = await getApi();
  const account = await orNull(api.accounts.get({ number: text }));
  if (!account) return { error: `No account ${text}, or it is outside the areas you can see` } as const;
  const points = await api.accounts.servicePoints.list({ accountId: account.id, limit: 50 });
  return { error: null, data: { accountName: account.customerName, points: points.map((p) => ({ id: p.id, address: p.address || "No address", status: p.connectionStatus })) } } as const;
}

type Boundary = { value: string; quality: string; note: string; rollover: boolean } | null;

function boundary(b: Boundary, digits: number, label: string) {
  if (!b) return { ok: true as const, value: undefined };
  const dial = parseDial(b.value, digits);
  if (!dial.ok) return { ok: false as const, error: `${label}: ${dial.problem}` };
  return { ok: true as const, value: { value: dial.value, source: "office" as const, quality: quality(b.quality), rolloverConfirmed: b.rollover, ...optionalText("note", b.note) } };
}

export async function installMeterAction(input: { id: string; meterId: string; dialDigits: number; servicePointId: string; installedAt: string; initial: Boundary }) {
  const when = at(input.installedAt);
  if (!when) return { error: "Choose when it was installed" } as const;
  if (!input.servicePointId) return { error: "Choose the service point" } as const;
  const initial = boundary(input.initial, input.dialDigits, "Initial reading");
  if (!initial.ok) return { error: initial.error } as const;
  return billingAction((api) =>
    api.metering.installations.install({ id: input.id, meterId: input.meterId, servicePointId: input.servicePointId, installedAt: when, ...(initial.value ? { initialReading: initial.value } : {}) }).then(() => null),
  );
}

export async function removeMeterAction(input: { id: string; meterId: string; dialDigits: number; removedAt: string; to: string; reason: string; final: Boundary }) {
  const when = at(input.removedAt);
  const to = REMOVE_TARGETS.find((t) => t === input.to);
  if (!when) return { error: "Choose when it was removed" } as const;
  if (!to) return { error: "Choose where the meter goes next" } as const;
  const final = boundary(input.final, input.dialDigits, "Final reading");
  if (!final.ok) return { error: final.error } as const;
  return billingAction((api) => api.metering.installations.remove({ id: input.id, meterId: input.meterId, removedAt: when, to, reason: input.reason.trim(), ...(final.value ? { finalReading: final.value } : {}) }).then(() => null));
}

export async function replaceMeterAction(input: {
  id: string;
  oldMeterId: string;
  oldDigits: number;
  newMeterId: string;
  newDigits: number;
  replacedAt: string;
  reason: string;
  final: NonNullable<Boundary>;
  initial: NonNullable<Boundary>;
}) {
  const when = at(input.replacedAt);
  if (!when) return { error: "Choose when the meter was replaced" } as const;
  const final = boundary(input.final, input.oldDigits, "Final reading of the old meter");
  const initial = boundary(input.initial, input.newDigits, "Initial reading of the new meter");
  if (!final.ok) return { error: final.error } as const;
  if (!initial.ok) return { error: initial.error } as const;
  if (!final.value || !initial.value) return { error: "Both readings are needed" } as const;
  return billingAction((api) =>
    api.metering.installations.replace({ id: input.id, oldMeterId: input.oldMeterId, newMeterId: input.newMeterId, replacedAt: when, reason: input.reason.trim(), finalReading: final.value!, initialReading: initial.value! }).then(() => null),
  );
}

/** Office entry of a reading (M-04): the meter by id, the dial as digits. The result says if validation flagged it. */
export async function recordReadingAction(input: { id: string; meterId: string; dialDigits: number; value: string; readAt: string; quality: string; note: string; rollover: boolean }) {
  const dial = parseDial(input.value, input.dialDigits);
  if (!dial.ok) return { error: dial.problem } as const;
  const when = at(input.readAt);
  if (!when) return { error: "Choose when the meter was read" } as const;
  return billingAction((api) =>
    api.metering.readings
      .record({ id: input.id, meterId: input.meterId, value: dial.value, readAt: when, source: "office", quality: quality(input.quality), rolloverConfirmed: input.rollover, ...optionalText("note", input.note) })
      .then((r) => ({ flags: r.reading.flags, cleared: r.reading.cleared, replayed: r.replayed })),
  );
}

export async function approveReadingAction(input: { readingId: string; rollover: boolean; reason: string }) {
  return billingAction((api) => api.metering.readings.approve({ readingId: input.readingId, rollover: input.rollover, reason: input.reason.trim() }).then(() => null));
}

export async function voidReadingAction(input: { readingId: string; reason: string }) {
  return billingAction((api) => api.metering.readings.void({ readingId: input.readingId, reason: input.reason.trim() }).then(() => null));
}

export async function takeSnapshotAction(input: { routeId: string; cycleDate: string }) {
  if (!input.routeId) return { error: "Choose a route" } as const;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.cycleDate)) return { error: "Choose the cycle date" } as const;
  return billingAction((api) => api.metering.snapshots.take({ routeId: input.routeId, cycleDate: input.cycleDate }).then((r) => ({ id: r.snapshot.id, replayed: r.replayed })));
}

/** The actual readings of a handover's meter, for choosing the closing reading. */
export async function closingCandidatesAction(meterId: string) {
  const { api } = await getApi();
  const rows = await api.metering.readings.list({ meterId, status: "valid", limit: 20 });
  return rows.filter((r) => r.kind === "actual").map((r) => ({ id: r.id, value: r.value, readAt: r.readAt.toISOString() }));
}

export async function linkClosingAction(input: { handoverId: string; readingId: string }) {
  if (!input.readingId) return { error: "Choose the closing reading" } as const;
  return billingAction((api) => api.metering.handovers.linkClosing(input).then(() => null));
}
