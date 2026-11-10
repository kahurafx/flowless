import { DISPOSITIONS } from "@flowless/shared-types";
import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/*
 * Metering's policy settings (NF-32): outcome mapping (M-06), consecutive misses (M-09),
 * zero consumption (M-10) and bulk meter schedules (M-12). Versioned configuration, read when used.
 */

const disposition = z.enum(DISPOSITIONS).optional();

/**
 * M-06: what each reading outcome means for billing. Partial: an outcome left out takes the
 * billing engine's default (`DEFAULT_OUTCOME_MAPPING`), so the stored value names only what the
 * organization changed.
 */
export const meteringOutcomesSchema = z.object({
  read_ok: disposition,
  meter_inaccessible: disposition,
  meter_faulty: disposition,
  no_meter_found: disposition,
  locked_premises: disposition,
  dog_or_hazard: disposition,
  customer_refused: disposition,
  illegal_connection_suspected: disposition,
});
export type MeteringOutcomes = z.infer<typeof meteringOutcomesSchema>;

export const meteringOutcomesSetting = defineSetting({
  key: "metering.outcomes",
  module: "metering",
  label: "Reading outcomes",
  description: "What billing does for each thing a reader can find at the meter: bill the actual reading, estimate, hold, standing charges only, or skip.",
  schema: meteringOutcomesSchema,
  default: {},
});

/**
 * M-09: the consecutive-miss thresholds (a miss is a visit with no reading), counted from the
 * outcome history. Each action fires once, when the count reaches its threshold; 0 switches it
 * off. The optional cap on consecutive estimates (S) alerts when that many estimates in a row
 * stand since the last actual reading; null for no cap.
 */
export const meteringMissesSchema = z.object({
  revisitAfter: z.number().int().min(0).max(24).default(2),
  selfReadPromptAfter: z.number().int().min(0).max(24).default(2),
  escalateAfter: z.number().int().min(0).max(24).default(4),
  maxConsecutiveEstimates: z.number().int().min(1).max(60).nullable().default(null),
});
export type MeteringMisses = z.infer<typeof meteringMissesSchema>;

export const meteringMissesSetting = defineSetting({
  key: "metering.misses",
  module: "metering",
  label: "Missed readings",
  description: "How many visits in a row without a reading ask for a revisit, a customer self-read prompt and an escalation, and the optional cap on consecutive estimates.",
  schema: meteringMissesSchema,
  default: { revisitAfter: 2, selfReadPromptAfter: 2, escalateAfter: 4, maxConsecutiveEstimates: null },
});

/** M-10: zero consumption is billed and flagged; this many zero readings in a row open a meter check (0 switches it off). */
export const meteringZeroSchema = z.object({ streakAfter: z.number().int().min(0).max(24).default(3) });
export type MeteringZero = z.infer<typeof meteringZeroSchema>;

export const meteringZeroSetting = defineSetting({
  key: "metering.zero_consumption",
  module: "metering",
  label: "Zero consumption",
  description: "How many zero-consumption readings in a row open a meter check.",
  schema: meteringZeroSchema,
  default: { streakAfter: 3 },
});

/** M-12 (S): how often each DMA's bulk meters are read, in days from a start date; a DMA with no entry has no schedule. */
export const meteringBulkSchema = z.object({
  schedules: z.array(z.object({ dmaId: z.uuid(), everyDays: z.number().int().min(1).max(366), startDate: z.iso.date() })).max(500).default([]),
});
export type MeteringBulk = z.infer<typeof meteringBulkSchema>;

export const meteringBulkSetting = defineSetting({
  key: "metering.bulk_schedules",
  module: "metering",
  label: "Bulk meter schedules",
  description: "How often the bulk meters of each DMA are read, counted in days from a start date.",
  schema: meteringBulkSchema,
  default: { schedules: [] },
});
