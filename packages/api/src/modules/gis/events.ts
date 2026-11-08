import { enqueueEvent, type Transaction } from "@flowless/db";
import { ASSET_CONDITIONS } from "@flowless/shared-types";
import { z } from "zod";
import { entitlementsChanged } from "../../kernel/entitlement-events";
import { defineConsumer, defineEvent, type EventDef } from "../../kernel/events";
import { ensureAttachmentRules } from "./rules";

/*
 * What GIS publishes on the kernel outbox (K-09), in place of Majimap's domain_events.
 * Network facts are published only once they are on main: a branch edit is a proposal.
 */

/** An asset's condition changed on main (an edit, an inspection, or a posted branch). */
export const gisConditionChanged = defineEvent(
  "gis.condition_changed",
  z.object({
    assetId: z.uuid(),
    from: z.enum(ASSET_CONDITIONS),
    to: z.enum(ASSET_CONDITIONS),
    changedByUserId: z.uuid(),
    reconciledFromBranch: z.string().optional(),
  }),
);

/**
 * A service connection went live on main: created there, or captured on a branch and
 * posted. GIS holds no customers: Accounts turns this into an enquiry or links the service
 * point (C-05) when it is licensed.
 */
export const gisConnectionPosted = defineEvent(
  "gis.connection_posted",
  z.object({
    connectionId: z.uuid(),
    connectionNumber: z.string(),
    location: z.object({ lat: z.number(), lng: z.number() }),
    servicePointId: z.uuid().nullable(),
    pipeId: z.uuid().nullable(),
    /** The branch it was captured on, or main when created there directly. */
    branch: z.string(),
    postedByUserId: z.uuid(),
  }),
);

const branchJob = z.object({ branch: z.string(), workOrderId: z.uuid(), actorUserId: z.uuid() });

/** A job with a branch was submitted: its changes wait for review (a feed for GIS engineers). */
export const gisBranchSubmitted = defineEvent("gis.branch_submitted", branchJob);
/** A job with a branch was approved: its branch is ready to post. Approval never posts by itself. */
export const gisBranchReady = defineEvent("gis.branch_ready_for_reconcile", branchJob);
/** A job with a branch was cancelled: its branch can now only be discarded. */
export const gisBranchCancelled = defineEvent("gis.branch_cancelled", branchJob);

/** Publishes from code that has only the transaction (the engine, the work-order effects). */
export async function emit<T>(tx: Transaction, organizationId: string, def: EventDef<T>, payload: T) {
  await enqueueEvent(tx, { organizationId, type: def.type, version: def.version, payload: def.schema.parse(payload) });
}

/**
 * Seeds an organization's structure-attachment rules from the defaults when it is licensed
 * for GIS. Idempotent: an organization that already has rules keeps them. GIS write
 * procedures seed on first use too, so a missed event never leaves the trigger refusing
 * every housed node.
 */
export const seedAttachmentRulesOnLicence = defineConsumer({
  name: "gis.seed_attachment_rules",
  module: "gis",
  event: entitlementsChanged,
  async handle({ tx, organizationId }, payload) {
    if (!payload.after.includes("gis")) return;
    await ensureAttachmentRules(tx, organizationId);
  },
});
