/**
 * Mock people and organization codes for the demo module exceptions and accounts (the codes
 * are the Better Auth slugs `pnpm db:seed` creates). Goes away as modules ship real data.
 */
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
