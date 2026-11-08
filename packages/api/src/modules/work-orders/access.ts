import type { Permission, Scope } from "@flowless/shared-types";

/*
 * Who may see and do what with jobs, from Flowless permissions (K-03) in place of
 * Majimap's roles. Majimap's "act" is `work_orders:execute`; its "manage" is
 * `work_orders:assign` (raise for anyone, act on any job, link anyone's logs, write to any
 * job branch), `work_orders:review` (approve, return, finalize parents) and
 * `work_orders:cancel`. Pure, so the whole matrix is tested without a database.
 */

export interface Abilities {
  /** Sees every job in scope. */
  read: boolean;
  /** Carries out jobs assigned to them. */
  execute: boolean;
  /** Raises jobs for anyone and acts on any job it can see (Majimap's manager). */
  assign: boolean;
  review: boolean;
  cancel: boolean;
}

export function abilitiesOf(permissions: ReadonlySet<Permission>): Abilities {
  return {
    read: permissions.has("work_orders:read"),
    execute: permissions.has("work_orders:execute"),
    assign: permissions.has("work_orders:assign"),
    review: permissions.has("work_orders:review"),
    cancel: permissions.has("work_orders:cancel"),
  };
}

/** May this member see jobs at all? Without any work-order permission they see none (Majimap's viewer). */
export const seesJobs = (a: Abilities) => a.read || a.execute || a.assign || a.review || a.cancel;

/** May this member act on jobs (transition, add assets, link logs, open the branch)? */
export const actsOnJobs = (a: Abilities) => a.execute || a.assign;

/**
 * What a caller may see: jobs assigned to them or to one of their crews, always; every
 * other job only with `work_orders:read` (or a manager's permission) and inside their
 * scope (K-03). A limited member sees jobs placed in their areas or routes; unplaced jobs
 * are for unrestricted members, as with exceptions.
 */
export interface Visibility {
  userId: string;
  crewIds: readonly string[];
  /** Sees beyond their own jobs. */
  all: boolean;
  scope: Scope;
}

export function visibilityFor(abilities: Abilities, userId: string, crewIds: readonly string[], scope: Scope): Visibility {
  return { userId, crewIds, all: abilities.read || abilities.assign || abilities.review || abilities.cancel, scope };
}

export interface JobPlace {
  assignedToUserId: string | null;
  crewId: string | null;
  areaId: string | null;
  routeId: string | null;
}

export function inScope(scope: Scope, job: Pick<JobPlace, "areaId" | "routeId">): boolean {
  if (scope.kind === "all") return true;
  return (job.areaId !== null && scope.areaIds.has(job.areaId)) || (job.routeId !== null && scope.routeIds.has(job.routeId));
}

/** The one rule for "may this caller see this job", shared by the router, files and the branch guard. */
export function canSeeJob(v: Visibility, job: JobPlace): boolean {
  if (job.assignedToUserId === v.userId) return true;
  if (job.crewId !== null && v.crewIds.includes(job.crewId)) return true;
  return v.all && inScope(v.scope, job);
}

/**
 * May this caller act on a job they can see? A manager on any; anyone else only on a job
 * assigned to them or their crew. An unassigned job is the managers' pool.
 */
export function canActOn(a: Abilities, v: Visibility, job: JobPlace): boolean {
  if (!canSeeJob(v, job)) return false;
  if (a.assign) return true;
  if (!a.execute) return false;
  return job.assignedToUserId === v.userId || (job.crewId !== null && v.crewIds.includes(job.crewId));
}
