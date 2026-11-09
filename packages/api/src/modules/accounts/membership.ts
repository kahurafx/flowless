import { membershipClassSchema, membershipConfigSchema, type MembershipClass, type MembershipConfig } from "@flowless/shared-types";

// The schemas are shared with the web form (`@flowless/shared-types`); the module keeps exporting them.
export { membershipClassSchema, membershipConfigSchema, type MembershipClass, type MembershipConfig };

/*
 * Membership classes (C-07), pure. A child account may carry a class, configured per
 * organization in `accounts.membership`. A class names the catalog item (by CODE, with no
 * foreign key: Accounts never reads Tariffs' tables) that prices the connection fee of a
 * member of that class, so a member pays a different connection fee than a stand-alone
 * customer. Billing reads the class with `membershipFor` and prices the line itself.
 */

/** The class with this key, or undefined. */
export const findClass = (config: MembershipConfig, key: string): MembershipClass | undefined => config.classes.find((c) => c.key === key);
