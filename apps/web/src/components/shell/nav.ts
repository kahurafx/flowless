import type { Entitlements, ModuleKey, Permission } from "@flowless/shared-types";
import { HomeIcon, InboxIcon, MapIcon, SettingsIcon, ShieldCheckIcon, UsersIcon, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the organization is licensed for it (K-04). Kernel items have none. */
  module?: ModuleKey;
  /** Shown only to members who hold it (K-03). */
  permission?: Permission;
}

// Specific labels, named for what is there (apple-design: wayfinding).
const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: HomeIcon },
  { href: "/exceptions", label: "Exceptions", icon: InboxIcon, permission: "exceptions:read" },
  { href: "/accounts", label: "Accounts", icon: UsersIcon, module: "accounts", permission: "accounts:read" },
  { href: "/settings/organization", label: "Organization", icon: SettingsIcon },
  { href: "/settings/areas", label: "Areas and routes", icon: MapIcon },
  { href: "/settings/team", label: "Team and permissions", icon: ShieldCheckIcon, permission: "access:manage" },
];

/**
 * Navigation is built from entitlements and the member's permissions, never hard-coded
 * per tenant (K-03, K-04, NF-32). Hiding is for wayfinding; procedures enforce access.
 */
export function navFor(entitlements: Entitlements, permissions: readonly Permission[]): NavItem[] {
  return NAV.filter(
    (item) =>
      (!item.module || entitlements.includes(item.module)) && (!item.permission || permissions.includes(item.permission)),
  );
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
