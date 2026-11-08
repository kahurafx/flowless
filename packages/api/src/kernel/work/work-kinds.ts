import type { ModuleKey } from "@flowless/shared-types";
import type { z } from "zod";
import type { EventDef } from "../events";

/** What a kind of job points at. "assets" is a route (valve exercising, meter reading). */
export type WorkKindTarget = "asset" | "assets" | "area" | "location" | "account";

export type WorkPriority = "low" | "normal" | "high" | "urgent";

/**
 * One kind of job (W-01), contributed by the module that owns the work, adopted from
 * Majimap. Available while its module is licensed and, for tier "full", only with the
 * Work Orders module. Registered in code, never in the database: adding a kind is a
 * deploy, not a migration. Review and SLA are defaults an organization can override in
 * the configuration store (K-10).
 */
export interface WorkKindDef {
  /** Stable key stored on the job: lower_snake_case, unique across every module. */
  readonly key: string;
  readonly module: ModuleKey;
  readonly label: string;
  readonly target: WorkKindTarget;
  /** Whether finishing the job needs a second person's approval. */
  readonly review: "none" | "optional" | "required";
  readonly tier: "basic" | "full";
  /** What the job does to network data, so reviewers know what to look at. */
  readonly gis: "none" | "logs" | "edits" | "creates";
  /** May the person in the field raise this kind for something they found? */
  readonly selfRaise?: boolean;
  /** What completing the job records (W-03), e.g. a meter serial and its first reading. */
  readonly capture?: z.ZodType<unknown>;
  /** Evidence required to complete: at least `photos` photos, and a GPS fix (W-02). */
  readonly evidence?: { photos?: number; gps?: boolean };
  /** Published on the outbox when a job of this kind completes (W-03), with its capture. */
  readonly completionEvent?: EventDef<unknown>;
  readonly defaultPriority?: WorkPriority;
  readonly slaHours?: number;
}

export function defineWorkKind(def: WorkKindDef): WorkKindDef {
  return def;
}
