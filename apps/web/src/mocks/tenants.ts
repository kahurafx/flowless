/**
 * Mock people for the exception queue, keyed by organization code (the Better Auth slug;
 * `pnpm db:seed` creates organizations with these codes). Settings and licensed modules are
 * real (kernel); this goes away when exceptions come from the kernel (A7).
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

const staff: Record<string, readonly Person[]> = {
  [MAJI_SAFI]: [people.wanjiru, people.baraka, people.achieng],
  [KILIMA]: [people.otieno, people.chebet],
};

/** Exception owners for an organization's mock queue. */
export function staffFor(code: string): readonly Person[] {
  return staff[code] ?? [];
}
