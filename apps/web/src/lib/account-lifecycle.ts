import type { CommercialStatus, Permission, ServiceState } from "@flowless/shared-types";

/*
 * Which lifecycle actions the account page offers a member (C-03, C-06, C-08 to C-11).
 * Wayfinding only: the state machine (`planCommand`) and the procedures decide. The rules
 * here mirror `modules/accounts/lifecycle.ts` so a button is not shown where it can never work.
 */

export const LIFECYCLE_ACTIONS = [
  "mark_pending_payment",
  "activate",
  "make_dormant",
  "reactivate",
  "disconnect_service",
  "reconnect_service",
  "terminate",
  "succeed",
  "change_name",
  "relocate",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export interface AccountStateView {
  commercialStatus: CommercialStatus;
  serviceStatus: ServiceState;
}

const FROM: Record<LifecycleAction, readonly CommercialStatus[]> = {
  mark_pending_payment: ["NEW"],
  activate: ["NEW", "PENDING_PAYMENT"],
  make_dormant: ["ACTIVE"],
  reactivate: ["DORMANT"],
  disconnect_service: ["ACTIVE", "DORMANT"],
  reconnect_service: ["ACTIVE"],
  terminate: ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT"],
  succeed: ["ACTIVE", "DORMANT"],
  change_name: ["NEW", "PENDING_PAYMENT", "ACTIVE", "DORMANT"],
  relocate: ["ACTIVE", "DORMANT"],
};

/**
 * The actions this account can take and the member may ask for. Everything needs
 * `accounts:change_status`; a service action also depends on the service axis. Activation
 * has its own panel, so the page leaves `activate` out of the button row.
 */
export function lifecycleActionsFor(account: AccountStateView, permissions: readonly Permission[]): LifecycleAction[] {
  if (!permissions.includes("accounts:change_status")) return [];
  return LIFECYCLE_ACTIONS.filter((action) => {
    if (!FROM[action].includes(account.commercialStatus)) return false;
    if (action === "disconnect_service") return account.serviceStatus === "CONNECTED";
    if (action === "reconnect_service") return account.serviceStatus === "DISCONNECTED";
    return true;
  });
}

/** Overriding unmet activation gates needs `settings:manage` (the procedure checks it too). */
export const canOverrideGates = (permissions: readonly Permission[]) => permissions.includes("settings:manage");
