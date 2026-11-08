import type { Transaction } from "@flowless/db";
import type { GeoPoint, ModuleKey, Permission } from "@flowless/shared-types";

/*
 * Ports between the modules that do field work (adopted from Majimap's kernel/ports.ts).
 * The kernel holds interfaces, never implementations: each module registers its adapter in
 * `packages/api/src/wiring.ts`, and Work Orders, GIS, Metering and the rest never import
 * each other (NF-30). Everything is in-process, so a port is a function call. Every port
 * gets the caller's tenant transaction, so RLS applies to whatever the adapter reads.
 */

/**
 * What a job needs to know about an asset, whichever module owns it. `registered` is live
 * data; `proposed` exists only on a branch not yet posted. `possibleDuplicateOf` is a hint
 * for a reviewer (a proposed asset almost on top of a registered one), never a rule.
 */
export interface AssetRef {
  id: string;
  module: ModuleKey;
  type: string;
  name: string;
  location: GeoPoint | null;
  state: "registered" | "proposed";
  possibleDuplicateOf: string | null;
}

/** "Does this asset exist, and what is it?" Ids the module does not own are absent from the result. */
export interface AssetResolver {
  readonly module: ModuleKey;
  resolve(tx: Transaction, ids: readonly string[]): Promise<Map<string, AssetRef>>;
}

/** A record that proves work happened (an inspection, a valve operation, a reading). */
export interface EvidenceRef {
  kind: string;
  id: string;
  assetId: string;
  recordedByUserId: string;
  recordedAt: Date;
  /**
   * The branch the record was made on, for modules whose data is branch-versioned (GIS).
   * A job only takes evidence recorded on its own branch, or on main when it has none.
   * Absent for modules without branches.
   */
  branch?: string;
}

export interface EvidenceResolver {
  readonly module: ModuleKey;
  /** The evidence kinds it answers for, e.g. ["condition", "valve"]. */
  readonly kinds: readonly string[];
  find(tx: Transaction, kind: string, id: string): Promise<EvidenceRef | null>;
}

export interface BranchWrite {
  organizationId: string;
  userId: string;
  permissions: ReadonlySet<Permission>;
  branch: string;
}
export type BranchVerdict = { allowed: true } | { allowed: false; reason: string };

/** Decides who may write to branches under one name prefix (lower-case, e.g. "wo-"). */
export interface BranchGuard {
  readonly prefix: string;
  check(tx: Transaction, write: BranchWrite): Promise<BranchVerdict>;
}

/** Where a branch came from, as the module that owns it describes it (shown on the reconcile screen). */
export interface BranchOrigin {
  kind: string;
  ref: string;
  id: string;
  title: string;
  status: string;
}

/** Labels branches under one prefix. The branch itself is never changed. */
export interface BranchAnnotator {
  readonly prefix: string;
  annotate(tx: Transaction, branches: readonly string[]): Promise<Map<string, BranchOrigin>>;
}

export interface WorkOrderEvent {
  organizationId: string;
  workOrderId: string;
  kind: string;
  actorUserId: string;
  branch: string | null;
}

/**
 * Hooks a module runs when a job moves, INSIDE the transition's transaction, so a failing
 * effect rolls the transition back. Work done elsewhere later goes through the job kind's
 * completion event on the outbox instead (W-03).
 */
export interface WorkOrderEffects {
  readonly module: ModuleKey;
  onSubmit?(tx: Transaction, event: WorkOrderEvent): Promise<void>;
  onApprove?(tx: Transaction, event: WorkOrderEvent): Promise<void>;
  onCancel?(tx: Transaction, event: WorkOrderEvent): Promise<void>;
}

/** "What unfinished work involves this asset?" Asked before an asset is deleted. */
export interface AssetWorkLookup {
  openWorkOn(tx: Transaction, assetId: string): Promise<{ code: string; title: string }[]>;
}
