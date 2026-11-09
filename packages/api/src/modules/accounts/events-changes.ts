import { APPLICATION_STAGES, SUCCESSION_BASES } from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

/*
 * What Accounts publishes for the application workflow, memberships, succession,
 * relocation and change of name (Phase 3 F3b), versioned (NF-32). `occurredAt` is ISO 8601.
 * Re-exported from `events.ts`.
 */

/**
 * The application workflow (C-05). These stage events are the hand-off to Billing (invoice
 * the new-connection fee when an application reaches `application`) and Payments: Phase 4
 * and 6 replace the opaque `markInvoiced` / `markPaid` references with events consumed here.
 */
export const applicationStageChanged = defineEvent(
  "accounts.application_stage_changed",
  z.object({
    applicationId: z.uuid(),
    /** The application_event row that recorded it. */
    eventId: z.uuid(),
    customerId: z.uuid(),
    /** Null when the application was created. */
    from: z.enum(APPLICATION_STAGES).nullable(),
    to: z.enum(APPLICATION_STAGES),
    reason: z.string(),
    /** Null when the system moved it (an approval's outcome, a completed survey job). */
    actorUserId: z.uuid().nullable(),
    occurredAt: z.iso.datetime(),
  }),
);

/** The application became an account (and a service point). */
export const applicationConverted = defineEvent(
  "accounts.application_converted",
  z.object({
    applicationId: z.uuid(),
    accountId: z.uuid(),
    accountNumber: z.string(),
    servicePointId: z.uuid(),
    customerId: z.uuid(),
    /** Tariffs' category, opaque to Accounts. */
    categoryId: z.uuid().nullable(),
    parentAccountId: z.uuid().nullable(),
    membershipClass: z.string().nullable(),
    convertedByUserId: z.uuid(),
    occurredAt: z.iso.datetime(),
  }),
);

/** A child account's membership class was set or cleared (C-07). */
export const membershipClassChanged = defineEvent(
  "accounts.membership_class_changed",
  z.object({
    accountId: z.uuid(),
    number: z.string(),
    parentAccountId: z.uuid(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    /** The catalog item code the new class prices the connection fee with, if it names one. */
    connectionFeeChargeItemCode: z.string().nullable(),
    actorUserId: z.uuid(),
    occurredAt: z.iso.datetime(),
  }),
);

/**
 * A successor account was created and the old one went DORMANT (C-08). `transfer` and
 * `readingHandover` say whether the balance and the final reading were handed over by the
 * registered ports, or are still waiting for the Ledger (Phase 4) and Metering (Phase 5).
 */
export const accountSucceeded = defineEvent(
  "accounts.account_succeeded",
  z.object({
    commandId: z.uuid(),
    basis: z.enum(SUCCESSION_BASES),
    predecessorAccountId: z.uuid(),
    predecessorNumber: z.string(),
    successorAccountId: z.uuid(),
    successorNumber: z.string(),
    previousCustomerId: z.uuid(),
    customerId: z.uuid(),
    servicePointIds: z.array(z.uuid()),
    transfer: z.enum(["done", "pending_ledger"]),
    readingHandover: z.enum(["done", "pending_metering"]),
    actorUserId: z.uuid(),
    occurredAt: z.iso.datetime(),
  }),
);

/** The holder of an account changed from `effectiveDate` (C-10), a change of name. */
export const holderChanged = defineEvent(
  "accounts.holder_changed",
  z.object({
    commandId: z.uuid(),
    accountId: z.uuid(),
    number: z.string(),
    fromCustomerId: z.uuid(),
    toCustomerId: z.uuid(),
    /** YYYY-MM-DD, in the organization's time zone: Billing splits the bill here. */
    effectiveDate: z.string(),
    closingReadingRef: z.string().nullable(),
    /** True while nobody has taken the previous holder's closing reading (Metering, Phase 5). */
    closingReadingPending: z.boolean(),
    actorUserId: z.uuid(),
    occurredAt: z.iso.datetime(),
  }),
);

const place = z.object({
  schemeId: z.uuid().nullable(),
  zoneId: z.uuid().nullable(),
  dmaId: z.uuid().nullable(),
  routeId: z.uuid().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});

/**
 * A relocation was completed (C-09): the account moved from one service point to a new one.
 * Billing and Metering react (re-derive the tariff, close and open meter installations).
 */
export const servicePointRelocated = defineEvent(
  "accounts.service_point_relocated",
  z.object({
    relocationId: z.uuid(),
    commandId: z.uuid(),
    accountId: z.uuid(),
    number: z.string(),
    fromServicePointId: z.uuid(),
    toServicePointId: z.uuid(),
    from: place,
    to: place,
    /** Charge item codes whose fees move with the customer: recorded, not invoiced. */
    feeItemCodes: z.array(z.string()),
    /** Opaque readings (text) until Metering exists. */
    finalReading: z.string().nullable(),
    initialReading: z.string().nullable(),
    actorUserId: z.uuid(),
    occurredAt: z.iso.datetime(),
  }),
);

/**
 * What a completed Accounts job publishes (W-03): the shape Work Orders gives every
 * `completionEvent`, read here by the fields Accounts uses (`capture` is the kind's form).
 */
const jobCompleted = z.object({
  workOrderId: z.uuid(),
  code: z.string(),
  kind: z.string(),
  outcome: z.string().nullable(),
  assetModule: z.string().nullable(),
  assetId: z.uuid().nullable(),
  completedByUserId: z.uuid().nullable(),
  approvedByUserId: z.uuid().nullable(),
  capture: z.unknown().nullable(),
});
export type JobCompleted = z.infer<typeof jobCompleted>;

/** A connection survey job was completed: the survey of an application. */
export const connectionSurveyCompleted = defineEvent("accounts.connection_survey_completed", jobCompleted);

/** A relocation job (final and initial readings) was completed. */
export const relocationWorkCompleted = defineEvent("accounts.relocation_work_completed", jobCompleted);
