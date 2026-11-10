import type { WorkLevel } from "@flowless/shared-types";

/**
 * What the signed-in member may do, from `access.me` (their permissions) and `entitlements.list`
 * (which decides the work level). The server enforces every one of these; this only hides UI that
 * would be refused. Majimap's roles became permissions (K-03): "act" is `work_orders:execute`,
 * "manage" is `work_orders:assign`, and so on.
 */
export type Abilities = {
  level: WorkLevel;
  /** Add and change network records (on a job's branch or one's own). */
  edit: boolean;
  remove: boolean;
  /** Post a branch to the live network (reconcile). */
  post: boolean;
  /** Carry out jobs: execute, or assign (a manager acts on any visible job). */
  act: boolean;
  /** Raise jobs for anyone, assign, and act on any visible job. */
  manage: boolean;
  /** Approve or return submitted work, and close parent jobs. */
  review: boolean;
  /** Any job screen at all: some work-order permission and a licensed work level. */
  seeJobs: boolean;
  /** Metering is licensed and the member may capture readings (M-04): the reading round and visits exist. */
  readings: boolean;
  /** Metering is licensed and the member may manage meters (replace a meter, M-07). */
  changeMeter: boolean;
};

export function abilitiesOf(permissions: readonly string[], level: WorkLevel, modules: readonly string[] = []): Abilities {
  const has = (p: string) => permissions.includes(p);
  const manage = has("work_orders:assign");
  const act = has("work_orders:execute") || manage;
  const review = has("work_orders:review");
  const metering = modules.includes("metering");
  return {
    level,
    edit: has("gis:edit"),
    remove: has("gis:delete"),
    post: has("gis:post"),
    act,
    manage,
    review,
    readings: metering && has("readings:read") && has("readings:capture"),
    changeMeter: metering && has("meters:read") && has("meters:manage"),
    seeJobs: level !== "none" && (act || review || has("work_orders:read") || has("work_orders:cancel")),
  };
}

export const NO_ABILITIES: Abilities = abilitiesOf([], "none");

/** The default roles' names, for the profile header. Unknown roles are shown as written. */
export function roleLabel(role: string): string {
  return role
    .split(",")
    .map((r) => r.trim().replace(/_/g, " "))
    .filter(Boolean)
    .map((r) => r.charAt(0).toUpperCase() + r.slice(1))
    .join(", ")
    .replace(/\bGis\b/g, "GIS");
}

/** The profile screen's "what you can do", in words. */
export function abilityLines(a: Abilities): string[] {
  return [
    "View the network and its history",
    ...(a.edit ? ["Record inspections and operate valves", "Add and edit assets on your jobs and your own changes"] : []),
    ...(a.act && a.level !== "none" ? ["Work your jobs and report problems"] : []),
    ...(a.manage ? ["Raise and assign jobs, and act on any job you can see"] : []),
    ...(a.readings ? ["Read meters on your route and record why a meter could not be read"] : []),
    ...(a.changeMeter ? ["Replace a meter"] : []),
    ...(a.review ? ["Approve or return submitted work, and close parent jobs"] : []),
    ...(a.post ? ["Review and post field changes to the live network"] : []),
    ...(a.remove ? ["Delete assets (on the web)"] : []),
  ];
}
