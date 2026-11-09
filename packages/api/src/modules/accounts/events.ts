import { CONTACT_CHANNELS, CUSTOMER_TYPES, SERVICE_POINT_STATUSES } from "@flowless/shared-types";
import { z } from "zod";
import { defineEvent } from "../../kernel/events";

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
