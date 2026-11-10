/**
 * Flowless permissions (K-03): what a member may do, as "<resource>:<action>".
 * A member's permissions are their role's defaults plus any extra permissions an
 * administrator granted them, so an organization can fit roles to how it works
 * without new roles or per-tenant code (NF-32). Data restrictions by scheme, zone or
 * route are separate (scope restrictions).
 */
export const PERMISSION_STATEMENTS = {
  settings: ["manage"],
  access: ["manage"],
  accounts: ["read", "create", "update", "change_status"],
  tariffs: ["read", "manage"],
  meters: ["read", "manage"],
  readings: ["read", "capture", "approve"],
  billing: ["read", "run", "approve", "adjust"],
  payments: ["read", "receipt", "allocate", "reverse"],
  collections: ["read", "manage", "approve_rebate"],
  work_orders: ["read", "assign", "execute", "review", "cancel"],
  gis: ["read", "edit", "delete", "post", "configure"],
  inventory: ["read", "manage"],
  communications: ["read", "send"],
  exceptions: ["read", "resolve"],
  reports: ["read", "export"],
  audit: ["read"],
} as const;

type Statements = typeof PERMISSION_STATEMENTS;
export type PermissionResource = keyof Statements;
export type Permission = { [R in PermissionResource]: `${R}:${Statements[R][number]}` }[PermissionResource];

export const PERMISSIONS: readonly Permission[] = Object.entries(PERMISSION_STATEMENTS).flatMap(
  ([resource, actions]) => actions.map((action) => `${resource}:${action}` as Permission),
);

const known = new Set<string>(PERMISSIONS);
export function isPermission(value: string): value is Permission {
  return known.has(value);
}

const ALL = PERMISSIONS;
const except = (...excluded: Permission[]) => ALL.filter((p) => !excluded.includes(p));

/**
 * Default roles and their permissions. `owner`, `admin` and `member` are also Better
 * Auth's built-in roles; the rest are Flowless roles named in the requirements.
 */
export const DEFAULT_ROLES = {
  owner: ALL,
  admin: ALL,
  manager: except("settings:manage", "access:manage"),
  accountant: [
    "accounts:read",
    "tariffs:read",
    "meters:read",
    "readings:read",
    "billing:read",
    "billing:run",
    "billing:approve",
    "billing:adjust",
    "payments:read",
    "payments:receipt",
    "payments:allocate",
    "payments:reverse",
    "collections:read",
    "collections:approve_rebate",
    "communications:read",
    "exceptions:read",
    "exceptions:resolve",
    "reports:read",
    "reports:export",
  ],
  clerk: [
    "accounts:read",
    "accounts:create",
    "accounts:update",
    "tariffs:read",
    "meters:read",
    "readings:read",
    "readings:capture",
    "billing:read",
    "payments:read",
    "communications:read",
    "exceptions:read",
    "exceptions:resolve",
    "reports:read",
  ],
  cashier: ["accounts:read", "payments:read", "payments:receipt", "payments:allocate", "exceptions:read", "reports:read"],
  supervisor: [
    "accounts:read",
    "meters:read",
    "meters:manage",
    "readings:read",
    "readings:approve",
    "work_orders:read",
    "work_orders:assign",
    "work_orders:review",
    "work_orders:cancel",
    "gis:read",
    "inventory:read",
    "exceptions:read",
    "exceptions:resolve",
    "reports:read",
  ],
  /** Keeps the network model: edits, posts branches to main, configures GIS (Majimap's gis_engineer). */
  gis_engineer: [
    "accounts:read",
    "gis:read",
    "gis:edit",
    "gis:delete",
    "gis:post",
    "gis:configure",
    "work_orders:read",
    "work_orders:assign",
    "work_orders:review",
    "work_orders:execute",
    "inventory:read",
    "exceptions:read",
    "exceptions:resolve",
    "reports:read",
  ],
  // gis:edit is limited to the technician's own job branches by the GIS branch guard (Phase 2).
  technician: [
    "accounts:read",
    "meters:read",
    "readings:read",
    "readings:capture",
    // No work_orders:read: technicians see the jobs given to them or their crew (W-01).
    "work_orders:execute",
    "gis:read",
    "gis:edit",
    "inventory:read",
  ],
  collector: ["accounts:read", "payments:read", "collections:read", "collections:manage", "work_orders:read"],
  member: ["accounts:read", "exceptions:read"],
} as const satisfies Record<string, readonly Permission[]>;

export type RoleKey = keyof typeof DEFAULT_ROLES;
export const ROLES = Object.keys(DEFAULT_ROLES) as RoleKey[];

/** Roles that sign in with email and administer the organization (requirements §1). */
export const ADMIN_ROLES: readonly RoleKey[] = ["owner", "admin"];

/** Better Auth stores several roles comma-separated. Unknown names are ignored. */
export function parseRoles(role: string): RoleKey[] {
  return role
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is RoleKey => Object.hasOwn(DEFAULT_ROLES, r));
}

/**
 * What a member may do: the defaults of each of their roles plus their extra grants.
 * Grants that are no longer in the catalogue are ignored.
 */
export function effectivePermissions(role: string, granted: Iterable<string> = []): ReadonlySet<Permission> {
  const result = new Set<Permission>(parseRoles(role).flatMap((r) => DEFAULT_ROLES[r]));
  for (const p of granted) if (isPermission(p)) result.add(p);
  return result;
}
