import { z } from "zod";

/*
 * Membership classes (C-07), pure. A child account may carry a class, configured per
 * organization in `accounts.membership`. A class names the catalog item (by CODE, with no
 * foreign key: Accounts never reads Tariffs' tables) that prices the connection fee of a
 * member of that class, so a member pays a different connection fee than a stand-alone
 * customer. Billing reads the class with `membershipFor` and prices the line itself.
 */

export const membershipClassSchema = z.object({
  /** Stable key stored on the account. */
  key: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/, "Use 2 to 30 lower-case letters, digits or _, starting with a letter"),
  label: z.string().trim().min(1).max(80),
  /** The charge catalog item (T-07) whose amount is the connection fee for this class. */
  connectionFeeChargeItemCode: z.string().trim().min(1).max(40).optional(),
});

export const membershipConfigSchema = z
  .object({ classes: z.array(membershipClassSchema).max(30).default([]) })
  .refine((c) => new Set(c.classes.map((k) => k.key)).size === c.classes.length, "Each class needs its own key");

export type MembershipConfig = z.infer<typeof membershipConfigSchema>;
export type MembershipClass = z.infer<typeof membershipClassSchema>;

/** The class with this key, or undefined. */
export const findClass = (config: MembershipConfig, key: string): MembershipClass | undefined => config.classes.find((c) => c.key === key);
