import type { Entitlements, ModuleKey } from "@flowless/shared-types";
import { HomeIcon, InboxIcon, SettingsIcon, UsersIcon, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the organization is licensed for it (K-04). Kernel items have none. */
  module?: ModuleKey;
}

// Specific labels, named for what is there (apple-design: wayfinding).
const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: HomeIcon },
  { href: "/exceptions", label: "Exceptions", icon: InboxIcon },
  { href: "/accounts", label: "Accounts", icon: UsersIcon, module: "accounts" },
  { href: "/settings/organization", label: "Organization", icon: SettingsIcon },
];

/** Navigation is built from entitlements, never hard-coded per tenant (K-04, NF-32). */
export function navFor(entitlements: Entitlements): NavItem[] {
  return NAV.filter((item) => !item.module || entitlements.includes(item.module));
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
