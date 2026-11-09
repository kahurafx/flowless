import { LATE_FEE_BASES, LATE_FEE_FREQUENCIES, type LateFeeBase } from "./tariffs";
import { z } from "zod";

/*
 * Late-fee rules (T-10) and their calculation, pure. Applying a fee (posting the charge,
 * keeping it once per period) is Billing's and Collections' job; this says how much a rule
 * asks for. Money is bigint minor units; a percentage is in basis points and rounded once,
 * half up (B-18).
 */

/** Days in one "month" of a monthly rule: it repeats every 30 days after the trigger. */
export const LATE_FEE_PERIOD_DAYS = 30;

export const lateFeeRuleSchema = z
  .object({
    /** Days after the due date the fee starts. */
    triggerDays: z.number().int().min(0).max(365),
    base: z.enum(LATE_FEE_BASES),
    /** Percentage in basis points (500 is 5%), 1 to 10000; or `flatAmount`, not both. */
    rateBp: z.number().int().min(1).max(10_000).nullable().default(null),
    flatAmount: z.bigint().min(1n).max(10n ** 12n).nullable().default(null),
    /** The most that is charged in all for one invoice; null for no cap. */
    cap: z.bigint().min(1n).max(10n ** 12n).nullable().default(null),
    frequency: z.enum(LATE_FEE_FREQUENCIES),
  })
  .refine((r) => (r.rateBp === null) !== (r.flatAmount === null), { message: "Give a rate or a flat amount, not both and not neither" });
export type LateFeeRule = z.infer<typeof lateFeeRuleSchema>;

/** The amounts a rule may be based on; pass a plain amount when you already chose the one `rule.base` names. */
export type LateFeeBasis = bigint | { overdueBalance: bigint; invoiceTotal: bigint };

export type LateFeeReason = "charged" | "not_overdue" | "before_trigger" | "no_balance" | "already_charged" | "capped" | "manual_only";

export interface LateFeeResult {
  /** To charge now, in minor units; never negative. */
  amount: bigint;
  /** What one application of the rule comes to before the cap. */
  perApplication: bigint;
  /** Applications due so far (1 for `once`, one per 30 days after the trigger for `monthly`). */
  applications: number;
  /** What the rule would add if staff applied it now (the amount for `manual_only`, else equal to `amount`). */
  suggested: bigint;
  reason: LateFeeReason;
}

const baseAmount = (basis: LateFeeBasis, base: LateFeeBase): bigint => (typeof basis === "bigint" ? basis : base === "overdue_balance" ? basis.overdueBalance : basis.invoiceTotal);

/** `amount * bp / 10000`, rounded half up. */
export const percentOf = (amount: bigint, bp: number): bigint => (amount * BigInt(bp) + 5000n) / 10_000n;

/**
 * What `rule` charges for an invoice that is `daysOverdue` days past due with `balance`
 * outstanding, given the late fees `alreadyCharged` on it. Nothing is due while the balance
 * is zero or less, before `triggerDays`, or once the cap is reached. `once` charges one
 * application; `monthly` one more every 30 days; `manual_only` never charges by itself but
 * reports what applying it would add (`suggested`).
 */
export function lateFee(rule: LateFeeRule, balance: LateFeeBasis, daysOverdue: number, alreadyCharged: bigint): LateFeeResult {
  const none = (reason: LateFeeReason, perApplication = 0n, applications = 0): LateFeeResult => ({ amount: 0n, perApplication, applications, suggested: 0n, reason });
  const base = baseAmount(balance, rule.base);
  const ceiling = typeof balance === "bigint" ? balance : balance.overdueBalance;
  if (daysOverdue < 1) return none("not_overdue");
  if (daysOverdue < rule.triggerDays) return none("before_trigger");
  if (base <= 0n || ceiling <= 0n) return none("no_balance");

  const perApplication = rule.flatAmount ?? percentOf(base, rule.rateBp!);
  const applications = rule.frequency === "monthly" ? Math.floor((daysOverdue - rule.triggerDays) / LATE_FEE_PERIOD_DAYS) + 1 : 1;
  const entitled = perApplication * BigInt(applications);
  const capped = rule.cap !== null && entitled > rule.cap ? rule.cap : entitled;
  const remaining = capped > alreadyCharged ? capped - alreadyCharged : 0n;

  if (rule.frequency === "manual_only") {
    // Staff apply it once, up to the cap, and see what is still open after earlier fees.
    const once = rule.cap !== null && perApplication > rule.cap ? rule.cap : perApplication;
    const open = once > alreadyCharged ? once - alreadyCharged : 0n;
    return { amount: 0n, perApplication, applications: 1, suggested: open, reason: "manual_only" };
  }
  if (remaining === 0n) {
    return { amount: 0n, perApplication, applications, suggested: 0n, reason: rule.cap !== null && alreadyCharged >= rule.cap ? "capped" : "already_charged" };
  }
  return { amount: remaining, perApplication, applications, suggested: remaining, reason: capped < entitled ? "capped" : "charged" };
}
