import { PERMISSIONS, type Permission } from "./permissions";

/** Support access (K-12) lasts at most this long; a new grant is needed after. */
export const SUPPORT_MAX_HOURS = 72;

/** Support engineers may only look: every read permission, nothing that changes data. */
export const SUPPORT_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => p.endsWith(":read"));
