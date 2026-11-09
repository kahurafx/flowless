import {
  ACCOUNT_COMMAND_KINDS,
  COMMERCIAL_STATUSES,
  CONTACT_CHANNELS,
  CUSTOMER_TYPES,
  SERVICE_POINT_STATUSES,
  SERVICE_STATES,
} from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

// Application workflow, membership, succession, relocation and change of name (F3b).
export * from "./events-changes";

/*
 * What Accounts publishes on the kernel outbox (K-09), versioned (NF-32). Payloads carry
 * ids and the facts consumers route on, not contact details: a consumer that needs a phone
 * number asks for it through Accounts' published interface.
 */

export const customerCreated = defineEvent(
  "accounts.customer_created",
  z.object({
    customerId: z.uuid(),
    type: z.enum(CUSTOMER_TYPES),
    /** Channels with a usable value (placeholders do not count), for consumers that message the customer. */
    reachableBy: z.array(z.enum(CONTACT_CHANNELS)),
    createdByUserId: z.uuid(),
  }),
);

export const accountOpened = defineEvent(
  "accounts.account_opened",
  z.object({
    accountId: z.uuid(),
    number: z.string(),
    customerId: z.uuid(),
    parentAccountId: z.uuid().nullable(),
    /** Tariffs' category, opaque to Accounts. */
    categoryId: z.uuid().nullable(),
    /** ISO 8601: payloads are JSON. */
    openedAt: z.iso.datetime(),
    openedByUserId: z.uuid(),
  }),
);

export const servicePointCreated = defineEvent(
  "accounts.service_point_created",
  z.object({
    servicePointId: z.uuid(),
    accountId: z.uuid(),
    schemeId: z.uuid().nullable(),
    zoneId: z.uuid().nullable(),
    dmaId: z.uuid().nullable(),
    routeId: z.uuid().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    connectionStatus: z.enum(SERVICE_POINT_STATUSES),
    /** GIS's service connection, when already linked. */
    gisConnectionId: z.uuid().nullable(),
    createdByUserId: z.uuid(),
  }),
);

/*
 * The account lifecycle (C-03, C-06, C-11). Every status command publishes in its own
 * transaction. Payloads are ids, from/to, the reason and the command that caused it;
 * `occurredAt` is ISO 8601.
 */
const commandFacts = {
  accountId: z.uuid(),
  number: z.string(),
  commandId: z.uuid(),
  reason: z.string(),
  /** Null when the system acted (automatic activation). */
  actorUserId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
};

/** The commercial status moved. */
export const accountStatusChanged = defineEvent(
  "accounts.account_status_changed",
  z.object({ ...commandFacts, kind: z.enum(ACCOUNT_COMMAND_KINDS), from: z.enum(COMMERCIAL_STATUSES), to: z.enum(COMMERCIAL_STATUSES) }),
);

/** The service moved between CONNECTED and DISCONNECTED (with an activation or termination too). */
export const serviceStatusChanged = defineEvent(
  "accounts.service_status_changed",
  z.object({
    ...commandFacts,
    kind: z.enum(ACCOUNT_COMMAND_KINDS),
    from: z.enum(SERVICE_STATES),
    to: z.enum(SERVICE_STATES),
    /** Why the service is disconnected after the change; null when connected. */
    serviceReason: z.string().nullable(),
  }),
);

/** The account became ACTIVE: by checklist, automatically, by an authorised override of the gates, or out of dormancy. */
export const accountActivated = defineEvent(
  "accounts.account_activated",
  z.object({
    ...commandFacts,
    from: z.enum(["NEW", "PENDING_PAYMENT", "DORMANT"]),
    via: z.enum(["checklist", "auto", "override", "reactivation"]),
    service: z.enum(SERVICE_STATES),
  }),
);

/** The account was terminated: terminal. Follow-ups (service points, final reading) belong to the modules that own them. */
export const accountTerminated = defineEvent(
  "accounts.account_terminated",
  z.object({
    ...commandFacts,
    from: z.enum(["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT"]),
    basis: z.enum(["settled", "written_off", "no_ledger"]),
    /** Minor units owed at termination as digits, or null with no ledger. */
    balance: z.string().nullable(),
    writeOffApprovalId: z.uuid().nullable(),
  }),
);
