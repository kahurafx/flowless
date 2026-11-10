import { METER_STATUSES, READING_FLAG_CODES, READING_SOURCES, READING_STATUSES } from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/*
 * What Metering publishes on the kernel outbox (K-09), versioned (NF-32). Payloads are JSON:
 * dial values are whole numbers, instants are ISO strings. Billing and others consume these;
 * none reads Metering's tables.
 */

const iso = z.iso.datetime();

/** A reading was recorded (M-02). `cleared` is false when a blocking flag keeps it out of automatic billing (M-05). */
export const readingRecorded = defineEvent(
  "metering.reading_recorded",
  z.object({
    readingId: z.uuid(),
    meterId: z.uuid(),
    servicePointId: z.uuid(),
    accountId: z.uuid().nullable(),
    value: z.number().int(),
    readAt: iso,
    source: z.enum(READING_SOURCES),
    purpose: z.enum(["routine", "initial", "final"]),
    flags: z.array(z.enum(READING_FLAG_CODES as [string, ...string[]])),
    cleared: z.boolean(),
    rolloverConfirmed: z.boolean(),
    /** M-11: read inside a closed period, so Billing may need a correction document (B-14). */
    inClosedPeriod: z.boolean(),
    replacesReadingId: z.uuid().nullable(),
  }),
);

/** A reading was approved, voided or superseded. */
export const readingStatusChanged = defineEvent(
  "metering.reading_status_changed",
  z.object({
    readingId: z.uuid(),
    meterId: z.uuid(),
    servicePointId: z.uuid(),
    accountId: z.uuid().nullable(),
    status: z.enum(READING_STATUSES),
    cleared: z.boolean(),
    rolloverConfirmed: z.boolean(),
    reason: z.string(),
  }),
);

export const meterStatusChanged = defineEvent(
  "metering.meter_status_changed",
  z.object({ meterId: z.uuid(), serial: z.string(), from: z.enum(METER_STATUSES).nullable(), to: z.enum(METER_STATUSES), reason: z.string() }),
);

export const meterInstalled = defineEvent(
  "metering.meter_installed",
  z.object({ meterId: z.uuid(), installationId: z.uuid(), servicePointId: z.uuid(), accountId: z.uuid().nullable(), installedAt: iso }),
);

export const meterRemoved = defineEvent(
  "metering.meter_removed",
  z.object({ meterId: z.uuid(), installationId: z.uuid(), servicePointId: z.uuid(), removedAt: iso, reason: z.string() }),
);

/** M-07: the old meter's final reading and the new meter's initial reading, taken together. */
export const meterReplaced = defineEvent(
  "metering.meter_replaced",
  z.object({
    servicePointId: z.uuid(),
    accountId: z.uuid().nullable(),
    oldMeterId: z.uuid(),
    newMeterId: z.uuid(),
    finalReadingId: z.uuid(),
    initialReadingId: z.uuid(),
    replacedAt: iso,
  }),
);
