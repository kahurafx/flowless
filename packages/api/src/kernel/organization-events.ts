import { organizationSettings } from "@flowless/db";
import { z } from "zod";
import { defineConsumer, defineEvent } from "./events";

/**
 * Published by packages/auth when Flowless onboards an organization (raw `enqueueEvent`,
 * since auth cannot import the api). The event id is the organization id.
 */
export const organizationCreated = defineEvent(
  "organization.created",
  z.object({
    name: z.string(),
    code: z.string(),
    settings: z.object({ currency: z.string().length(3), timeZone: z.string(), locale: z.string() }).partial().optional(),
  }),
);

/** Defaults for a new organization; it changes them in settings (K-10 owns them later). */
export const DEFAULT_ORGANIZATION_SETTINGS = { currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" } as const;

/** Gives every new organization its settings row (NF-33, B-18). */
export const createOrganizationSettings = defineConsumer({
  name: "kernel.organization_settings",
  module: "kernel",
  event: organizationCreated,
  async handle({ tx, organizationId }, payload) {
    await tx
      .insert(organizationSettings)
      .values({ organizationId, ...DEFAULT_ORGANIZATION_SETTINGS, ...payload.settings })
      .onConflictDoNothing();
  },
});
