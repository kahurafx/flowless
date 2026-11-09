import type { Transaction } from "@flowless/db";
import type { DataQualityRuleKey, ModuleKey } from "@flowless/shared-types";
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

/*
 * Succession and change of name (C-08, C-10) hand a balance and a meter reading from one
 * account or holder to the next. Neither the sub-ledger (Phase 4) nor readings (Phase 5)
 * exist yet, so those are ports too: with none registered, or its modules unlicensed, the
 * command records that the step is still pending (`transfer: "pending_ledger"`,
 * `readingHandover: "pending_metering"`, `closingReadingPending`) so the module that ships
 * can reconcile it later. A registered port runs INSIDE the command's transaction, so a
 * failure rolls the whole command back, and must be idempotent by `commandId`.
 */

export interface BalanceTransferRequest {
  fromAccountId: string;
  toAccountId: string;
  /** The `succeed` command: the paired transfer entries are keyed by it. */
  commandId: string;
}
/** Billing registers it: post the paired transfer entries (excluded from revenue and collection statistics). */
export type BalanceTransfer = (tx: Transaction, organizationId: string, request: BalanceTransferRequest) => Promise<void>;

export interface ReadingHandoverRequest {
  reason: "succession" | "change_name";
  fromAccountId: string;
  toAccountId: string;
  servicePointIds: readonly string[];
  /** YYYY-MM-DD: the day the final (closing) reading is taken and the opening one starts. */
  effectiveDate: string;
  commandId: string;
}
/** Metering registers it; it may return the reference of the closing reading it recorded. */
export type ReadingHandover = (tx: Transaction, organizationId: string, request: ReadingHandoverRequest) => Promise<{ closingReadingRef?: string | null } | void>;

interface RegisteredPort<T> {
  handler: T;
  requires: readonly ModuleKey[];
}

let balanceTransfer: RegisteredPort<BalanceTransfer> | null = null;
let readingHandover: RegisteredPort<ReadingHandover> | null = null;

/** `requires`: the modules that must be licensed for the port to be used (Billing registers with ["billing"]). Null removes it. */
export function registerBalanceTransfer(handler: BalanceTransfer | null, options: { requires?: readonly ModuleKey[] } = {}): void {
  balanceTransfer = handler ? { handler, requires: options.requires ?? [] } : null;
}

/** `requires`: the modules that must be licensed (Metering registers with ["metering"]). Null removes it. */
export function registerReadingHandover(handler: ReadingHandover | null, options: { requires?: readonly ModuleKey[] } = {}): void {
  readingHandover = handler ? { handler, requires: options.requires ?? [] } : null;
}

async function usable<T>(tx: Transaction, port: RegisteredPort<T> | null): Promise<T | null> {
  if (!port) return null;
  if (port.requires.length) {
    const licensed = await loadEntitlements(tx);
    if (!port.requires.every((m) => licensed.includes(m))) return null;
  }
  return port.handler;
}

/** Moves the balance if a ledger is there; otherwise says it is still to do. */
export async function transferBalance(tx: Transaction, organizationId: string, request: BalanceTransferRequest): Promise<"done" | "pending_ledger"> {
  const handler = await usable(tx, balanceTransfer);
  if (!handler) return "pending_ledger";
  await handler(tx, organizationId, request);
  return "done";
}

/** Hands the reading over if Metering is there; otherwise says it is still to do. */
export async function handOverReadings(
  tx: Transaction,
  organizationId: string,
  request: ReadingHandoverRequest,
): Promise<{ state: "done" | "pending_metering"; closingReadingRef: string | null }> {
  const handler = await usable(tx, readingHandover);
  if (!handler) return { state: "pending_metering", closingReadingRef: null };
  const result = await handler(tx, organizationId, request);
  return { state: "done", closingReadingRef: (result && result.closingReadingRef) || null };
}

/*
 * Data-quality sources (C-12). A rule whose facts live in another module (`active_metered_no_meter`:
 * Metering, Phase 5) asks that module through this port: the source returns the ids of the
 * organization's accounts that break the rule, inside the caller's tenant transaction. With no
 * source registered, or one of its `requires` modules unlicensed, the rule reports "no source"
 * and is skipped, never failed.
 */
export type DataQualitySource = (tx: Transaction, organizationId: string) => Promise<readonly string[]>;

const dataQualitySources = new Map<string, RegisteredPort<DataQualitySource>>();

/** Registers the source of a data-quality rule; pass null to remove it (tests do). `requires`: modules that must be licensed (Metering registers with ["metering"]). */
export function registerDataQualitySource(ruleKey: DataQualityRuleKey, source: DataQualitySource | null, options: { requires?: readonly ModuleKey[] } = {}): void {
  if (source === null) dataQualitySources.delete(ruleKey);
  else dataQualitySources.set(ruleKey, { handler: source, requires: options.requires ?? [] });
}

/** The account ids a rule's source reports, or null when there is no usable source ("no source"). */
export async function dataQualitySourceIds(tx: Transaction, organizationId: string, ruleKey: DataQualityRuleKey): Promise<string[] | null> {
  const handler = await usable(tx, dataQualitySources.get(ruleKey) ?? null);
  return handler ? [...new Set(await handler(tx, organizationId))] : null;
}

/** Is a source registered for the rule and licensed for this organization (without asking it)? */
export async function hasUsableDataQualitySource(tx: Transaction, ruleKey: DataQualityRuleKey): Promise<boolean> {
  return (await usable(tx, dataQualitySources.get(ruleKey) ?? null)) !== null;
}
