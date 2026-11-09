import { CHARGE_TYPES, REVENUE_KINDS, TARIFF_TYPES } from "@flowless/shared-types";
import { z } from "zod";
import { entitlementsChanged } from "../../kernel/entitlement-events";
import { defineConsumer, defineEvent } from "../../kernel/events";
import { organizationCreated } from "../../kernel/organization-events";
import { ensureDefaults } from "./defaults";

/*
 * What Tariffs publishes on the kernel outbox (K-09), versioned (NF-32), and the consumers
 * that give a new organization its default categories, charge catalog and invoice types.
 * Payloads are JSON: money is a decimal string of minor units, dates are "YYYY-MM-DD".
 */

const minor = z.string().regex(/^\d+$/, "minor units as digits");

/** A tariff has a new version (including its first). Billing prices with the version in force. */
export const tariffVersionCreated = defineEvent(
  "tariffs.tariff_version_created",
  z.object({
    tariffId: z.uuid(),
    versionId: z.uuid(),
    versionNo: z.number().int(),
    type: z.enum(TARIFF_TYPES),
    effectiveFrom: z.iso.date(),
    createdByUserId: z.uuid(),
  }),
);

/** A charge catalog item was added. */
export const chargeItemCreated = defineEvent(
  "tariffs.charge_item_created",
  z.object({
    chargeItemId: z.uuid(),
    code: z.string(),
    type: z.enum(CHARGE_TYPES),
    revenueKind: z.enum(REVENUE_KINDS),
    createdByUserId: z.uuid(),
  }),
);

/** A charge item has a new amount from a date (also published for its first amount). */
export const chargeItemAmountChanged = defineEvent(
  "tariffs.charge_item_amount_changed",
  z.object({
    chargeItemId: z.uuid(),
    code: z.string(),
    versionNo: z.number().int(),
    effectiveFrom: z.iso.date(),
    amount: minor,
    previousAmount: minor.nullable(),
    createdByUserId: z.uuid(),
  }),
);

/** An invoice type was created or its terms, overdue policy, line template or late-fee rule changed. */
export const invoiceTypeChanged = defineEvent(
  "tariffs.invoice_type_changed",
  z.object({
    invoiceTypeId: z.uuid(),
    code: z.string(),
    change: z.enum(["created", "updated", "lines_set", "late_fee_rule_set"]),
    changedByUserId: z.uuid(),
  }),
);

/**
 * Seeds the defaults when an organization is created and Tariffs is already licensed, and
 * when Tariffs is licensed later (most organizations are licensed after onboarding). Both
 * run `ensureDefaults`, which only adds what is missing, so a repeat or a replay writes
 * nothing. The write procedures do not seed: a missed event is fixed by replaying it.
 */
export const seedDefaultsOnCreation = defineConsumer({
  name: "tariffs.seed_defaults_on_creation",
  module: "tariffs",
  event: organizationCreated,
  async handle({ tx, organizationId }) {
    await ensureDefaults(tx, organizationId);
  },
});

export const seedDefaultsOnLicence = defineConsumer({
  name: "tariffs.seed_defaults_on_licence",
  module: "tariffs",
  event: entitlementsChanged,
  async handle({ tx, organizationId }, payload) {
    if (!payload.after.includes("tariffs") || payload.before.includes("tariffs")) return;
    await ensureDefaults(tx, organizationId);
  },
});
