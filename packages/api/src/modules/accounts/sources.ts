import type { Transaction } from "@flowless/db";
import type { ModuleKey } from "@flowless/shared-types";
import { loadEntitlements } from "../../kernel/entitlement-store";
import type { GateFact } from "./gates";
import type { Position } from "./termination";

/*
 * Ports through which later modules tell Accounts what it cannot know itself (NF-30, NF-31),
 * in the manner of Tariffs' closed-period port. Nothing is registered until the module that
 * can speak for a fact ships; until then the office checklist (C-06) and an explicit
 * acknowledgement (C-11) stand in. Modules register once, at start-up, through the
 * module's `index.ts`.
 */

/** A module's answer for one gate and account, or null when it has no answer ("no source yet"). */
export type GateSource = (tx: Transaction, organizationId: string, accountId: string) => Promise<GateFact | null>;

interface RegisteredSource {
  source: GateSource;
  /** Modules that must all be licensed for the organization before the source is asked. */
  requires: readonly ModuleKey[];
}

const gateSources = new Map<string, RegisteredSource>();

/**
 * Registers the source for a built-in gate (`payment_threshold`: Billing, `meter_installed`:
 * Work Orders with Inventory, `initial_reading`: Metering). `requires` lists the modules that
 * provide it: while any is unlicensed for an organization the source is not asked at all, so
 * an unlicensed module never affects activation (NF-31) and the gate falls back to the
 * checklist. Registering again replaces; pass null to remove (tests do).
 */
export function registerGateSource(gateKey: string, source: GateSource | null, options: { requires?: readonly ModuleKey[] } = {}): void {
  if (source === null) gateSources.delete(gateKey);
  else gateSources.set(gateKey, { source, requires: options.requires ?? [] });
}

/** Is a source registered for the gate (whether or not it is licensed for this organization)? */
export const hasGateSource = (gateKey: string) => gateSources.has(gateKey);

/** What the registered, licensed sources say about this account, for the gates asked for. */
export async function gatherFacts(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  gateKeys: readonly string[],
): Promise<Record<string, GateFact | null>> {
  const facts: Record<string, GateFact | null> = {};
  let licensed: readonly ModuleKey[] | undefined;
  for (const key of gateKeys) {
    const registered = gateSources.get(key);
    facts[key] = null;
    if (!registered) continue;
    if (registered.requires.length) {
      licensed ??= await loadEntitlements(tx);
      if (!registered.requires.every((m) => licensed!.includes(m))) continue;
    }
    facts[key] = await registered.source(tx, organizationId, accountId);
  }
  return facts;
}

/** The ledger's position of an account: null means "no ledger yet" (C-11). */
export type TerminationCheck = (tx: Transaction, organizationId: string, accountId: string) => Promise<Position | null>;

let terminationCheck: TerminationCheck | null = null;

/** Billing registers the final-bill and balance check in Phase 4; pass null to go back to "no ledger" (tests do). */
export function registerTerminationCheck(check: TerminationCheck | null): void {
  terminationCheck = check;
}

export async function positionOf(tx: Transaction, organizationId: string, accountId: string): Promise<Position | null> {
  return terminationCheck ? terminationCheck(tx, organizationId, accountId) : null;
}
