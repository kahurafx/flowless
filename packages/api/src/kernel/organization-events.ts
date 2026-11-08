import { organizationSettings } from "@flowless/db";
import { z } from "zod";
import { writeSetting } from "./config-store";
import { defineConsumer, defineEvent } from "./events";
import { regionalSetting } from "./regional";

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

/** Defaults for a new organization. Time zone and language can change later (K-10); currency cannot. */
export const DEFAULT_ORGANIZATION_SETTINGS = { currency: "KES", ...regionalSetting.default } as const;

/** Gives every new organization its currency (B-18) and version 1 of its time zone and language (NF-33). */
export const createOrganizationSettings = defineConsumer({
  name: "kernel.organization_settings",
  module: "kernel",
  event: organizationCreated,
  async handle({ tx, organizationId }, payload) {
    const { currency, timeZone, locale } = { ...DEFAULT_ORGANIZATION_SETTINGS, ...payload.settings };
    await tx.insert(organizationSettings).values({ organizationId, currency }).onConflictDoNothing();
    // Version 1 exactly, so a second delivery writes nothing.
    await writeSetting(tx, organizationId, regionalSetting, { value: { timeZone, locale }, version: 1, reason: "Onboarding" });
  },
});
