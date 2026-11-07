import type { Entitlements } from "@flowless/shared-types";

// Same ids as the canary tenants in @flowless/db/testing, so mock and real data line up.
export const TENANT_A = "00000000-0000-4000-8000-00000000000a";
export const TENANT_B = "00000000-0000-4000-8000-00000000000b";

export interface MockOrganization {
  id: string;
  name: string;
  slug: string;
  settings: { currency: string; timeZone: string; locale: string };
  entitlements: Entitlements;
  /** The signed-in mock user for this tenant. */
  currentUser: { id: string; name: string; email: string; role: string };
  staff: readonly Person[];
}

export interface Person {
  id: string;
  name: string;
}

const wanjiru = { id: "user-wanjiru", name: "Wanjiru Kamau" };
const otieno = { id: "user-otieno", name: "Otieno Odhiambo" };

/** Exception owners across both tenants. */
export const people = {
  wanjiru,
  baraka: { id: "user-baraka", name: "Baraka Mwangi" },
  achieng: { id: "user-achieng", name: "Achieng Atieno-Wekesa" },
  otieno,
  chebet: { id: "user-chebet", name: "Chebet" },
} as const;

export const organizations: readonly MockOrganization[] = [
  {
    id: TENANT_A,
    name: "Maji Safi Water & Sanitation Company",
    slug: "maji-safi",
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "en-KE" },
    entitlements: ["accounts", "tariffs", "metering", "billing", "payments", "communications", "collections", "reporting"],
    currentUser: { ...wanjiru, email: "wanjiru@majisafi.co.ke", role: "Billing supervisor" },
    staff: [people.wanjiru, people.baraka, people.achieng],
  },
  {
    // A small project licensed for the foundation only: Communications and Collections are off.
    id: TENANT_B,
    name: "Kilima Community Water Project",
    slug: "kilima",
    settings: { currency: "KES", timeZone: "Africa/Nairobi", locale: "sw-KE" },
    entitlements: ["accounts", "tariffs", "metering", "billing", "payments"],
    currentUser: { ...otieno, email: "otieno@kilima.or.ke", role: "Accountant" },
    staff: [people.otieno, people.chebet],
  },
];

