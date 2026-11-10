import { CYCLE_EVENT_KINDS, CYCLE_OUTCOMES, CYCLE_STATES } from "@flowless/db/schema/billing";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/* What the billing cycle publishes on the outbox (K-09), versioned (NF-32). Dates are "YYYY-MM-DD". */

export const cycleOpened = defineEvent(
  "billing.cycle_opened",
  z.object({
    cycleId: z.uuid(),
    routeId: z.uuid(),
    period: z.string(),
    cycleDate: z.iso.date(),
    /** Metering's eligibility snapshot (the same one the reading tasks use); null when Metering is not licensed. */
    snapshotId: z.uuid().nullable(),
    trigger: z.enum(["on_reading", "batch"]),
    accounts: z.number().int(),
    expected: z.number().int(),
  }),
);

export const cycleStateChanged = defineEvent(
  "billing.cycle_state_changed",
  z.object({ cycleId: z.uuid(), routeId: z.uuid(), period: z.string(), from: z.enum(CYCLE_STATES), to: z.enum(CYCLE_STATES), kind: z.enum(CYCLE_EVENT_KINDS), reason: z.string().nullable() }),
);

/** The cycle closed: its period is locked for normal postings (B-15). */
export const cycleClosed = defineEvent(
  "billing.cycle_closed",
  z.object({ cycleId: z.uuid(), routeId: z.uuid(), period: z.string(), lockedThrough: z.iso.date(), expected: z.number().int() }),
);

export const cycleOutcomeRecorded = defineEvent(
  "billing.cycle_outcome_recorded",
  z.object({ cycleId: z.uuid(), accountId: z.uuid(), outcome: z.enum(CYCLE_OUTCOMES), reason: z.string().nullable(), exceptionId: z.uuid().nullable(), documentId: z.uuid().nullable() }),
);
