import type { Transaction } from "@flowless/db";
import { WORK_PROVIDER_MODULES, type ModuleKey, type WorkLevel } from "@flowless/shared-types";
import type {
  AssetRef,
  AssetResolver,
  AssetWorkLookup,
  BranchAnnotator,
  BranchGuard,
  BranchOrigin,
  BranchVerdict,
  BranchWrite,
  EvidenceRef,
  EvidenceResolver,
  WorkOrderEffects,
  WorkOrderEvent,
} from "./ports";
import type { WorkKindDef } from "./work-kinds";

const MAIN = "main";
const lowerPrefix = (prefix: string, what: string) => {
  if (!prefix || prefix !== prefix.toLowerCase()) throw new Error(`A ${what} prefix must be non-empty and lower-case`);
};
const overlaps = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The work registry (adopted from Majimap's kernel/registry.ts): what modules contribute
 * to field work, filled once at startup by `packages/api/src/wiring.ts`. Registering twice
 * is a wiring bug, so it throws. Lookups take the organization's licensed modules, so an
 * unlicensed module's adapters are never asked (NF-31). Tests build their own instance.
 */
export class WorkRegistry {
  private readonly assetResolvers = new Map<ModuleKey, AssetResolver>();
  private readonly evidenceResolvers = new Map<ModuleKey, EvidenceResolver>();
  private readonly guards: BranchGuard[] = [];
  private readonly reservedPrefixes: string[] = [];
  private readonly annotators: BranchAnnotator[] = [];
  private readonly effects: WorkOrderEffects[] = [];
  private readonly kinds = new Map<string, WorkKindDef>();
  private assetWork: AssetWorkLookup | null = null;

  registerAssetResolver(resolver: AssetResolver) {
    if (this.assetResolvers.has(resolver.module)) throw new Error(`Asset resolver for "${resolver.module}" is already registered`);
    this.assetResolvers.set(resolver.module, resolver);
  }

  registerEvidenceResolver(resolver: EvidenceResolver) {
    if (this.evidenceResolvers.has(resolver.module)) throw new Error(`Evidence resolver for "${resolver.module}" is already registered`);
    for (const kind of resolver.kinds) {
      for (const other of this.evidenceResolvers.values()) {
        if (other.kinds.includes(kind)) throw new Error(`Evidence kind "${kind}" is already claimed by "${other.module}"`);
      }
    }
    this.evidenceResolvers.set(resolver.module, resolver);
  }

  /**
   * Branch names with this prefix belong to a module. Until its guard is registered, writes
   * are refused: a missing adapter must never mean "anyone may write". Case-insensitive, so
   * "WO-1" cannot walk past "wo-".
   */
  reserveBranchPrefix(prefix: string) {
    lowerPrefix(prefix, "reserved branch");
    if (!this.reservedPrefixes.includes(prefix)) this.reservedPrefixes.push(prefix);
  }

  registerBranchGuard(guard: BranchGuard) {
    lowerPrefix(guard.prefix, "branch guard");
    if (this.guards.some((g) => overlaps(g.prefix, guard.prefix))) throw new Error(`Branch guard prefix "${guard.prefix}" overlaps one already registered`);
    this.guards.push(guard);
    this.reserveBranchPrefix(guard.prefix);
  }

  registerBranchAnnotator(annotator: BranchAnnotator) {
    lowerPrefix(annotator.prefix, "branch annotator");
    if (this.annotators.some((a) => overlaps(a.prefix, annotator.prefix))) {
      throw new Error(`Branch annotator prefix "${annotator.prefix}" overlaps one already registered`);
    }
    this.annotators.push(annotator);
  }

  registerEffects(effects: WorkOrderEffects) {
    if (this.effects.some((e) => e.module === effects.module)) throw new Error(`Effects for "${effects.module}" are already registered`);
    this.effects.push(effects);
  }

  registerAssetWork(lookup: AssetWorkLookup) {
    if (this.assetWork) throw new Error("Asset work lookup is already registered");
    this.assetWork = lookup;
  }

  registerWorkKind(def: WorkKindDef) {
    if (!/^[a-z][a-z0-9_]*$/.test(def.key)) throw new Error(`Work kind key "${def.key}" must be lower_snake_case`);
    if (this.kinds.has(def.key)) throw new Error(`Work kind "${def.key}" is already registered`);
    if (def.tier === "basic" && def.module !== "work-orders" && !WORK_PROVIDER_MODULES.includes(def.module)) {
      throw new Error(`Work kind "${def.key}": only modules that run field work without Work Orders may have basic kinds`);
    }
    this.kinds.set(def.key, def);
  }

  /** Assets from every licensed module's resolver, merged; an id nobody recognises is absent. */
  async resolveAssets(tx: Transaction, ids: readonly string[], licensed: readonly ModuleKey[]): Promise<Map<string, AssetRef>> {
    const found = new Map<string, AssetRef>();
    if (ids.length === 0) return found;
    // In turn on purpose: a transaction runs one query at a time anyway.
    for (const resolver of this.assetResolvers.values()) {
      if (!licensed.includes(resolver.module)) continue;
      for (const [id, ref] of await resolver.resolve(tx, ids)) if (!found.has(id)) found.set(id, ref);
    }
    return found;
  }

  /** Null when the record has not arrived yet or its module is unlicensed; callers treat both alike. */
  async findEvidence(tx: Transaction, kind: string, id: string, licensed: readonly ModuleKey[]): Promise<EvidenceRef | null> {
    for (const resolver of this.evidenceResolvers.values()) {
      if (licensed.includes(resolver.module) && resolver.kinds.includes(kind)) return resolver.find(tx, kind, id);
    }
    return null;
  }

  /** May this person write to this branch? Main is outside this check: the owning module's permissions govern it. */
  async checkBranchWrite(tx: Transaction, write: BranchWrite): Promise<BranchVerdict> {
    if (write.branch === MAIN) return { allowed: true };
    const name = write.branch.toLowerCase();
    const guard = this.guards.find((g) => name.startsWith(g.prefix));
    if (guard) return guard.check(tx, write);
    if (this.reservedPrefixes.some((prefix) => name.startsWith(prefix))) {
      return { allowed: false, reason: "That branch name is reserved for another module" };
    }
    return { allowed: true };
  }

  /** Where each branch came from, for the branches some module recognises. */
  async annotateBranches(tx: Transaction, branches: readonly string[]): Promise<Map<string, BranchOrigin>> {
    const found = new Map<string, BranchOrigin>();
    for (const annotator of this.annotators) {
      const mine = branches.filter((b) => b.toLowerCase().startsWith(annotator.prefix));
      if (mine.length === 0) continue;
      for (const [branch, origin] of await annotator.annotate(tx, mine)) found.set(branch, origin);
    }
    return found;
  }

  async runEffects(hook: "onSubmit" | "onApprove" | "onCancel", tx: Transaction, event: WorkOrderEvent, licensed: readonly ModuleKey[]) {
    for (const effects of this.effects) if (licensed.includes(effects.module)) await effects[hook]?.(tx, event);
  }

  /** Unfinished jobs involving an asset; empty when no module tracks jobs. */
  async openWorkOn(tx: Transaction, assetId: string): Promise<{ code: string; title: string }[]> {
    return this.assetWork ? this.assetWork.openWorkOn(tx, assetId) : [];
  }

  getWorkKind(key: string): WorkKindDef | undefined {
    return this.kinds.get(key);
  }

  /** The kinds an organization may raise: its licensed modules' kinds, and full-tier ones only at level `full`. */
  availableKinds(licensed: readonly ModuleKey[], level: WorkLevel): WorkKindDef[] {
    if (level === "none") return [];
    return [...this.kinds.values()].filter((k) => licensed.includes(k.module) && (k.tier === "basic" || level === "full"));
  }
}
