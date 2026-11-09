import type { FlatBasis } from "@flowless/shared-types";
import type { Band, Content, FlatAmount } from "./tariff-content";

/*
 * View models for the Tariffs screens: where a version stands in time, a tariff's content as
 * table rows, and what an assignment keeps or changes. Pure, so the wording and the rules
 * are tested without a browser. Dates are `YYYY-MM-DD` in the organization's time zone.
 */

export type VersionStatus = "in_force" | "scheduled" | "past" | "replaced";

export interface Dated {
  effectiveFrom: string;
  /** First day it no longer applies (the next version's start); null while it is the latest. */
  until: string | null;
}

/**
 * Where a version stands today. A version whose `until` equals its start covers no days: a
 * later version took its date before it arrived (`replaced`). Otherwise it is `scheduled`
 * (starts after today), `in_force`, or `past`.
 */
export function versionStatus(version: Dated, today: string): VersionStatus {
  if (version.until !== null && version.until === version.effectiveFrom) return "replaced";
  if (version.effectiveFrom > today) return "scheduled";
  if (version.until !== null && version.until <= today) return "past";
  return "in_force";
}

export const versionStatusLabel: Record<VersionStatus, string> = {
  in_force: "In force",
  scheduled: "Scheduled",
  past: "Superseded",
  replaced: "Replaced before it started",
};

export interface TimelineEntry<T extends Dated> {
  version: T;
  status: VersionStatus;
}

/** Versions newest first with their status; the one in force and the next scheduled are easy to find. */
export function versionTimeline<T extends Dated & { versionNo: number }>(versions: readonly T[], today: string) {
  const entries: TimelineEntry<T>[] = [...versions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.versionNo - a.versionNo).map((version) => ({ version, status: versionStatus(version, today) }));
  const inForce = entries.find((e) => e.status === "in_force") ?? null;
  const scheduled = entries.filter((e) => e.status === "scheduled");
  const next = [...scheduled].sort((a, b) => a.version.effectiveFrom.localeCompare(b.version.effectiveFrom))[0] ?? null;
  return { entries, inForce, next };
}

/** The entry in force on a date: the latest start on or before it, the highest version number among equals (the API's rule). */
export function inForceOn<T extends { effectiveFrom: string; versionNo: number }>(versions: readonly T[], date: string): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.effectiveFrom > date) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.versionNo > best.versionNo)) best = v;
  }
  return best;
}

/* ---------- content as rows ---------- */

export interface BandRow {
  position: number;
  /** "Units 1 to 6", "Units 21 and over". */
  range: string;
  from: number;
  to: number | null;
  rate: bigint;
}

/** A band covers the units after `from` up to and including `to`, so [0, 6] is units 1 to 6. */
export function bandRows(bands: readonly Band[]): BandRow[] {
  return bands.map((b, position) => ({
    position,
    range: b.to === null ? `Units ${b.from + 1} and over` : b.from + 1 === b.to ? `Unit ${b.to}` : `Units ${b.from + 1} to ${b.to}`,
    from: b.from,
    to: b.to,
    rate: b.rate,
  }));
}

export interface FlatRow {
  key: string;
  amount: bigint;
}

export function flatRows(amounts: readonly FlatAmount[], basis: FlatBasis): FlatRow[] {
  return amounts.map((a) => ({ key: a.key ?? (basis === "none" ? "Every account" : "Any"), amount: a.amount }));
}

/** What the table shows for a content: the rows and which kind of table it is. */
export type ContentTable = { kind: "bands"; rows: BandRow[] } | { kind: "uniform"; rate: bigint } | { kind: "flat"; rows: FlatRow[] };

export function contentTable(content: Content, basis: FlatBasis): ContentTable {
  switch (content.type) {
    case "increasing_block":
    case "decreasing_block":
      return { kind: "bands", rows: bandRows(content.bands) };
    case "uniform":
      return { kind: "uniform", rate: content.rate };
    case "flat_rate":
      return { kind: "flat", rows: flatRows(content.amounts, basis) };
  }
}

/* ---------- category assignment (T-02) ---------- */

export const KEEP = "__keep";

export interface AssignmentFields {
  tariffId: string | null;
  standingChargeItemId: string | null;
  meterRentItemId: string | null;
  discountItemId: string | null;
}

/** What the form has chosen for each of the four: `KEEP`, `""` for none, or an id. */
export interface AssignmentChoice {
  tariffId: string;
  standingChargeItemId: string;
  meterRentItemId: string;
  discountItemId: string;
}

export const ASSIGNMENT_KEYS = ["tariffId", "standingChargeItemId", "meterRentItemId", "discountItemId"] as const;
export type AssignmentKey = (typeof ASSIGNMENT_KEYS)[number];

export const assignmentKeyLabel: Record<AssignmentKey, string> = {
  tariffId: "Tariff",
  standingChargeItemId: "Standing charge",
  meterRentItemId: "Meter rent",
  discountItemId: "Discount",
};

export const keepAll: AssignmentChoice = { tariffId: KEEP, standingChargeItemId: KEEP, meterRentItemId: KEEP, discountItemId: KEEP };

/**
 * The API's reading of the choices: anything left out keeps the value in force on the
 * effective date, `null` clears it, an id sets it. So "keep" is omitted, "none" is null.
 */
export function assignmentInput(choice: AssignmentChoice) {
  const out: Partial<Record<AssignmentKey, string | null>> = {};
  for (const key of ASSIGNMENT_KEYS) {
    const value = choice[key];
    if (value !== KEEP) out[key] = value === "" ? null : value;
  }
  return out;
}

export function assignmentChanged(choice: AssignmentChoice, current: AssignmentFields | null): boolean {
  return ASSIGNMENT_KEYS.some((key) => choice[key] !== KEEP && (choice[key] || null) !== (current?.[key] ?? null));
}

/** The outcome of each of the four after the change, for the "what this does" lines. */
export function assignmentOutcome(choice: AssignmentChoice, current: AssignmentFields | null, nameOf: (key: AssignmentKey, id: string) => string) {
  return ASSIGNMENT_KEYS.map((key) => {
    const before = current?.[key] ?? null;
    const picked = choice[key];
    const after = picked === KEEP ? before : picked === "" ? null : picked;
    const label = (id: string | null) => (id === null ? "none" : nameOf(key, id));
    return {
      key,
      label: assignmentKeyLabel[key],
      kind: picked === KEEP ? ("kept" as const) : after === before ? ("same" as const) : after === null ? ("cleared" as const) : ("changed" as const),
      before: label(before),
      after: label(after),
    };
  });
}
