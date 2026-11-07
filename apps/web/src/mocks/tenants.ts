import type { Entitlements } from "@flowless/shared-types";

/**
 * Mock organization profiles, keyed by organization code (the Better Auth slug;
 * `pnpm db:seed` creates organizations with these codes). Settings and entitlements move to the kernel
 * configuration store (A8) and entitlements table (A4); then this file goes away.
 */
export interface OrganizationProfile {
  settings: { currency: string; timeZone: string; locale: string };
  entitlements: Entitlements;
  staff: readonly Person[];
}

export interface Person {
  id: string;
  name: string;
}

/** Exception owners across both mock tenants. */
export const people = {
  wanjiru: { id: "user-wanjiru", name: "Wanjiru Kamau" },
  baraka: { id: "user-baraka", name: "Baraka Mwangi" },
  achieng: { id: "user-achieng", name: "Achieng Atieno-Wekesa" },
  otieno: { id: "user-otieno", name: "Otieno Odhiambo" },
  chebet: { id: "user-chebet", name: "Chebet" },
} as const;

export const MAJI_SAFI = "majisafi";
export const KILIMA = "kilima";

const profiles: Record<string, OrganizationProfile> = {
  [MAJI_SAFI]: {
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" },
    entitlements: ["accounts", "tariffs", "metering", "billing", "payments", "communications", "collections", "reporting"],
    staff: [people.wanjiru, people.baraka, people.achieng],
  },
  // A small project licensed for the foundation only: Communications and Collections are off.
  [KILIMA]: {
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "sw-KE" },
    entitlements: ["accounts", "tariffs", "metering", "billing", "payments"],
    staff: [people.otieno, people.chebet],
  },
};

/** Any other organization (for example one created after sign-up) gets the foundation tier. */
const defaultProfile: OrganizationProfile = {
  settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" },
  entitlements: ["accounts", "tariffs", "metering", "billing", "payments"],
  staff: [],
};

export function profileFor(slug: string): OrganizationProfile {
  return profiles[slug] ?? defaultProfile;
}
