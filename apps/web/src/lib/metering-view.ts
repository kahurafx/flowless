import { METER_TRANSITIONS, READING_FLAGS, isBlockingFlag, type EligibilityReason, type MeterStatus, type ReadingFlag } from "@flowless/shared-types";

/*
 * Metering display and form helpers (M-01 to M-12). Pure; the procedures decide.
 */

export const METER_STATUS_LABELS: Record<MeterStatus, string> = {
  procured: "Procured",
  in_stock: "In stock",
  issued: "Issued",
  installed: "Installed",
  tested: "Tested",
  replaced: "Replaced",
  disposed: "Disposed",
};

export const METER_KIND_LABELS = { customer: "Customer", bulk: "Bulk (DMA)", master: "Master (scheme)" } as const;

export const ELIGIBILITY_LABELS: Record<EligibilityReason, string> = {
  eligible: "Eligible",
  consumption_not_billed: "Consumption not billed (status table)",
  no_meter: "No meter installed",
  service_point_not_live: "Service point not live",
};

export const TASK_STATE_LABELS = { to_read: "To read", read: "Read", missed: "Missed" } as const;

export const QUALITY_LABELS = { good: "Good", doubtful: "Doubtful", poor: "Poor" } as const;
export const SOURCE_LABELS = { technician: "Technician", office: "Office", customer: "Customer", import: "Import", estimate: "Estimate" } as const;

/**
 * Statuses the status button offers for a meter. `installed` and `replaced` are reached only by
 * install, remove and replace, and a meter that is installed cannot be moved by status at all
 * (M-01): the table minus those.
 */
export function statusMoves(status: MeterStatus): MeterStatus[] {
  if (status === "installed") return [];
  return METER_TRANSITIONS[status].filter((to) => to !== "installed" && to !== "replaced");
}

/** Where a removed meter can go next (the remove procedure's list). */
export const REMOVE_TARGETS = ["in_stock", "tested", "replaced", "disposed"] as const;

export interface FlagMark {
  code: string;
  label: string;
  blocking: boolean;
}

/** The validation flags of a reading with their wording; an unknown code is blocking, as the API treats it. */
export function flagMarks(flags: readonly string[]): FlagMark[] {
  return flags.map((code) => ({ code, label: (READING_FLAGS as Record<string, { label: string }>)[code]?.label ?? code, blocking: isBlockingFlag(code) }));
}

/** A flagged reading waits for review when a blocking flag is on it and it is still valid and not cleared. */
export const needsReview = (r: { status: string; cleared: boolean }) => r.status === "valid" && !r.cleared;

/** A reading the reviewer may confirm as a rollover: it dropped below the last reading and the dial could have wrapped. */
export const canConfirmRollover = (r: { flags: readonly string[]; rolloverConfirmed: boolean }) => !r.rolloverConfirmed && (r.flags as readonly ReadingFlag[]).includes("ROLLOVER_CANDIDATE");

/** A dial typed into a form: whole digits only (decimal dials are not modelled), within the digits the meter has. */
export function parseDial(text: string, digits?: number): { ok: true; value: number } | { ok: false; problem: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, problem: "Enter the dial as whole digits, like 01482" };
  if (digits !== undefined && t.length > digits) return { ok: false, problem: `This meter has ${digits} digits` };
  const n = Number(t);
  return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false, problem: "That number is too large" };
}

/** The value of a `datetime-local` input ("2026-05-04T09:30", the browser's local time) as an instant; null when empty or invalid. */
export function instantFromLocal(text: string): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The current local time as a `datetime-local` value. */
export function nowLocalInput(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** Units since the previous reading, or why there are none. */
export function unitsText(r: { units: number | null; previousValue: number | null; flags: readonly string[] }): string {
  if (r.previousValue === null) return "First reading";
  if (r.units === null) return r.flags.includes("ROLLOVER_CANDIDATE") ? "Needs rollover confirmation" : "Below the previous reading";
  return String(r.units);
}
