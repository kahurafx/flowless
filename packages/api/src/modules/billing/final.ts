import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { UserActionEnv } from "../../kernel/action-env";
import { chargeItemAmountInForce } from "../tariffs";
import { documentByKey, lockAccount, postDraft } from "./post";
import { announceIssued, holdBill, presentPosted, todayOf, usageInputSchema, prepareUsage, type IssueResult } from "./usage";

/*
 * The final bill on disconnection (B-12, C-11, S-9, S-10): the final reading's units, the
 * month's standing charge and the turn-off fee, priced by the engine's `finalBill`, posted
 * like any invoice and marked `final_bill` so Accounts' termination check can find it. Once
 * per event key: the document's idempotency key is `final:<eventKey>`, so a repeat returns
 * the first final bill and posts nothing. The status table does not hold a final bill (the
 * engine lets it through whatever the status).
 */

export const finalInputSchema = usageInputSchema
  .omit({ idempotencyKey: true, reading: true })
  .extend({
    /** The disconnection event's key; one final bill per key. */
    eventKey: z.string().trim().min(8).max(120),
    /** The mandatory final dial reading. */
    dial: z.number().int().min(0),
    rollover: z.boolean().optional(),
    /** The catalog item for the turn-off fee; its amount in force today is charged. Omit for no fee. */
    turnOffFeeChargeItemId: z.uuid().optional(),
  });
export type FinalInput = z.infer<typeof finalInputSchema>;

export const finalKey = (eventKey: string) => `final:${eventKey}`;

export async function issueFinal(env: UserActionEnv, input: FinalInput): Promise<IssueResult> {
  await lockAccount(env.tx, input.accountId);
  const key = finalKey(input.eventKey);
  const earlier = await documentByKey(env.tx, key);
  if (earlier) {
    if (earlier.accountId !== input.accountId || !earlier.finalBill) {
      throw new TRPCError({ code: "CONFLICT", message: "That event key was used for a different request" });
    }
    return { outcome: "issued", replayed: true, document: await presentPosted(env.tx, earlier) };
  }
  let fee = 0n;
  let feeItem: { chargeItemId: string | null; amountId: string | null } = { chargeItemId: null, amountId: null };
  if (input.turnOffFeeChargeItemId) {
    const amount = await chargeItemAmountInForce(env.tx, env.organizationId, input.turnOffFeeChargeItemId, await todayOf(env.tx));
    if (!amount) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The turn-off fee has no amount in force" });
    fee = amount.amount;
    feeItem = { chargeItemId: input.turnOffFeeChargeItemId, amountId: amount.id };
  }
  const bill = usageInputSchema.parse({
    ...usageInputSchema.omit({ idempotencyKey: true, reading: true }).parse(input),
    idempotencyKey: key,
    reading: { dial: input.dial, ...(input.rollover !== undefined ? { rollover: input.rollover } : {}) },
  });
  const prepared = await prepareUsage(env, bill, new Set(), { key, fee, feeChargeItemId: feeItem.chargeItemId, feeChargeItemAmountId: feeItem.amountId });
  if (prepared.kind === "held") {
    return { outcome: "held", code: prepared.code, message: prepared.message, exceptionId: await holdBill(env, input.accountId, prepared) };
  }
  if (prepared.kind === "none") return { outcome: prepared.outcome };
  if (prepared.kind === "skipped") return { outcome: "skipped", code: prepared.code, message: prepared.message };
  const posted = await postDraft(env, prepared.draft);
  await announceIssued(env, posted);
  return { outcome: "issued", replayed: false, document: await presentPosted(env.tx, posted.document) };
}
