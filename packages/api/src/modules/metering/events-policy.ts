import { DISPOSITIONS, READING_OUTCOMES } from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/*
 * Events of the outcome, miss, zero-consumption and snapshot policies (M-06 to M-10), versioned
 * (NF-32). Billing, Communications and Work Orders consume these; none reads Metering's tables.
 */

const iso = z.iso.datetime();

/** M-06: a visit to read a service point, with what was found and what billing should do about it. */
export const readingAttempted = defineEvent(
  "metering.reading_attempted",
  z.object({
    attemptId: z.uuid(),
    servicePointId: z.uuid(),
    accountId: z.uuid().nullable(),
    meterId: z.uuid().nullable(),
    cycleDate: z.iso.date().nullable(),
    outcome: z.enum(READING_OUTCOMES),
    disposition: z.enum(DISPOSITIONS),
    readingId: z.uuid().nullable(),
    attemptedAt: iso,
    consecutiveMisses: z.number().int().min(0),
  }),
);

/** M-09: the customer should be asked for a self-reading (Communications sends it). */
export const selfReadPromptDue = defineEvent(
  "metering.self_read_prompt_due",
  z.object({ servicePointId: z.uuid(), accountId: z.uuid().nullable(), consecutiveMisses: z.number().int(), cycleDate: z.iso.date().nullable() }),
);

/** M-09: a revisit or an escalation is due (an exception today; a Work Orders job once it can be raised). */
export const missThresholdReached = defineEvent(
  "metering.miss_threshold_reached",
  z.object({ servicePointId: z.uuid(), accountId: z.uuid().nullable(), consecutiveMisses: z.number().int(), action: z.enum(["revisit", "escalate"]) }),
);

/** M-09 (S): too many estimates in a row. */
export const estimateCapReached = defineEvent(
  "metering.estimate_cap_reached",
  z.object({ servicePointId: z.uuid(), accountId: z.uuid().nullable(), consecutiveEstimates: z.number().int(), cap: z.number().int() }),
);

/** M-10: zero consumption several readings running; a meter check was opened. */
export const zeroConsumptionStreak = defineEvent(
  "metering.zero_consumption_streak",
  z.object({ meterId: z.uuid(), servicePointId: z.uuid(), accountId: z.uuid().nullable(), streak: z.number().int() }),
);

/** M-08: a route's eligibility was fixed for a cycle. */
export const eligibilitySnapshotTaken = defineEvent(
  "metering.eligibility_snapshot_taken",
  z.object({ snapshotId: z.uuid(), routeId: z.uuid(), cycleDate: z.iso.date(), rows: z.number().int(), eligible: z.number().int() }),
);

/** C-08, C-10: a closing reading is owed (or was found) for a service point changing hands. */
export const readingHandoverOpened = defineEvent(
  "metering.reading_handover_opened",
  z.object({ handoverId: z.uuid(), commandId: z.uuid(), servicePointId: z.uuid(), meterId: z.uuid(), effectiveDate: z.iso.date(), closingReadingId: z.uuid().nullable() }),
);
