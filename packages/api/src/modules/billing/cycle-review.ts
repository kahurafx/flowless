import type { CycleOutcomeKind } from "@flowless/db/schema/billing";

/*
 * Review helpers (B-16), pure. Review is by exception: a bill is `clean` (small, not flagged)
 * and may be approved in bulk, or needs `attention` (flagged or over the bulk threshold), and
 * above the `high` threshold only a member who may approve (`billing:approve`) decides.
 * A random sample of the clean set is held back for a person to spot-check.
 */

export interface ReviewThresholds {
  /** Minor units: a clean bill at or under this may be bulk approved. */
  bulkApproveBelow: bigint;
  /** Minor units: over this, approving needs `billing:approve`. */
  individualAbove: bigint;
}

export type ReviewBucket = "clean" | "attention" | "high";

export function reviewBucket(bill: { outcome: CycleOutcomeKind; amount: bigint | null; flagged: boolean }, t: ReviewThresholds): ReviewBucket | null {
  if (bill.outcome !== "billed" && bill.outcome !== "billed_estimate") return null;
  const amount = bill.amount ?? 0n;
  const size = amount < 0n ? -amount : amount;
  if (size > t.individualAbove) return "high";
  if (bill.flagged || size > t.bulkApproveBelow) return "attention";
  return "clean";
}

/** FNV-1a, 32 bit: a stable, dependency-free hash for the deterministic sample. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which ids to spot-check: `max(minimum, ceil(rate * n))` of them (at most all), picked by
 * hashing each id with the seed, so the same cycle always gives the same sample and a replayed
 * bulk approval selects the same accounts.
 */
export function sampleSelection(ids: readonly string[], opts: { rate: number; minimum: number; seed: string }): string[] {
  if (ids.length === 0) return [];
  const size = Math.min(ids.length, Math.max(opts.minimum, Math.ceil(opts.rate * ids.length)));
  return [...ids]
    .map((id) => ({ id, h: fnv1a(`${opts.seed}:${id}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : 1))
    .slice(0, size)
    .map((x) => x.id);
}
