import type { Entitlements, ModuleKey, Permission } from "@flowless/shared-types";
import {
  BadgeCheckIcon,
  ContactRoundIcon,
  CoinsIcon,
  DatabaseZapIcon,
  FileTextIcon,
  GaugeIcon,
  LayersIcon,
  ReceiptTextIcon,
  FilePlus2Icon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  GitMergeIcon,
  HistoryIcon,
  HomeIcon,
  InboxIcon,
  LifeBuoyIcon,
  MapIcon,
  MapPinnedIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only when the organization is licensed for it (K-04). Kernel items have none. */
  module?: ModuleKey;
  /** Shown only when the organization is licensed for any of these (a screen several modules bring, K-04). */
  anyModule?: readonly ModuleKey[];
  /** Shown only to members who hold it (K-03). */
  permission?: Permission;
  /** Shown only to members who hold at least one of these. */
  anyPermission?: readonly Permission[];
}

/** Who sees jobs at all (the Work Orders router turns everyone else away). */
const WORK_PERMISSIONS = ["work_orders:read", "work_orders:execute", "work_orders:assign", "work_orders:review", "work_orders:cancel"] as const;

// Specific labels, named for what is there (apple-design: wayfinding).
const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: HomeIcon },
  { href: "/exceptions", label: "Exceptions", icon: InboxIcon, permission: "exceptions:read" },
  // Approvals is a kernel screen (K-05): any member may open it, and sees only requests they are involved in.
  { href: "/approvals", label: "Approvals", icon: BadgeCheckIcon },
  // The Accounts group (C-01 to C-12), kept together.
  { href: "/accounts", label: "Accounts", icon: UsersIcon, module: "accounts", permission: "accounts:read" },
  { href: "/accounts/customers", label: "Customers", icon: ContactRoundIcon, module: "accounts", permission: "accounts:read" },
  { href: "/accounts/applications", label: "Applications", icon: FilePlus2Icon, module: "accounts", permission: "accounts:read" },
  { href: "/accounts/data-quality", label: "Data quality", icon: DatabaseZapIcon, module: "accounts", permission: "accounts:read" },
  // The Tariffs group (T-01 to T-10): tariffs, categories, the charge catalog and invoice types.
  { href: "/tariffs", label: "Tariffs", icon: GaugeIcon, module: "tariffs", permission: "tariffs:read" },
  { href: "/tariffs/categories", label: "Categories", icon: LayersIcon, module: "tariffs", permission: "tariffs:read" },
  { href: "/tariffs/charges", label: "Charge catalog", icon: CoinsIcon, module: "tariffs", permission: "tariffs:read" },
  { href: "/tariffs/invoice-types", label: "Invoice types", icon: ReceiptTextIcon, module: "tariffs", permission: "tariffs:read" },
  // Work Orders shows at level basic or full: the Work Orders module or GIS (W-01).
  { href: "/work-orders", label: "Work orders", icon: ClipboardListIcon, anyModule: ["work-orders", "gis"], anyPermission: WORK_PERMISSIONS },
  { href: "/work-orders/reviews", label: "Job reviews", icon: ClipboardCheckIcon, anyModule: ["work-orders", "gis"], permission: "work_orders:review" },
  { href: "/work-orders/crews", label: "Crews", icon: UsersRoundIcon, module: "work-orders", anyPermission: WORK_PERMISSIONS },
  { href: "/map", label: "Network map", icon: MapPinnedIcon, module: "gis", permission: "gis:read" },
  { href: "/map/reconcile", label: "Pending changes", icon: GitMergeIcon, module: "gis", permission: "gis:post" },
  { href: "/settings/organization", label: "Organization", icon: SettingsIcon },
  { href: "/settings/areas", label: "Areas and routes", icon: MapIcon },
  { href: "/settings/accounts", label: "Accounts settings", icon: FileTextIcon, module: "accounts", permission: "settings:manage" },
  { href: "/settings/team", label: "Team and permissions", icon: ShieldCheckIcon, permission: "access:manage" },
  { href: "/settings/audit", label: "Audit log", icon: HistoryIcon, permission: "audit:read" },
  { href: "/settings/support", label: "Support access", icon: LifeBuoyIcon, permission: "access:manage" },
];

/**
 * Navigation is built from entitlements and the member's permissions, never hard-coded
 * per tenant (K-03, K-04, NF-32). Hiding is for wayfinding; procedures enforce access.
 */
export function navFor(entitlements: Entitlements, permissions: readonly Permission[]): NavItem[] {
  return NAV.filter(
    (item) =>
      (!item.module || entitlements.includes(item.module)) &&
      (!item.anyModule || item.anyModule.some((m) => entitlements.includes(m))) &&
      (!item.permission || permissions.includes(item.permission)) &&
      (!item.anyPermission || item.anyPermission.some((p) => permissions.includes(p))),
  );
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The one item that is current: the most specific match, so "Job reviews" is not also "Work orders". */
export function currentHref(pathname: string, items: readonly NavItem[]): string | null {
  const matches = items.filter((item) => isActive(pathname, item.href));
  return matches.reduce<string | null>((best, item) => (best === null || item.href.length > best.length ? item.href : best), null);
}
