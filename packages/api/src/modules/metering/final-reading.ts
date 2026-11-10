import type { Transaction } from "@flowless/db";
import { installation, meter } from "@flowless/db/schema/metering";
import { and, eq, isNull } from "drizzle-orm";
import type { UserActionEnv } from "../../kernel/action-env";
import { recordReading, type Recorded } from "./readings";

/*
 * Published for Billing's disconnection (B-12, M-02): which customer meter is installed at a
 * service point now, and the one write Billing makes, the final reading, through the same
 * `recordReading` as every reading (validation, exception for a blocking flag, event).
 */

/** The customer meter installed (not removed) at the service point; null when there is none. */
export async function currentMeterOf(tx: Transaction, servicePointId: string): Promise<{ meterId: string; dialDigits: number } | null> {
  const [row] = await tx
    .select({ meterId: meter.id, dialDigits: meter.dialDigits })
    .from(installation)
    .innerJoin(meter, eq(meter.id, installation.meterId))
    .where(and(eq(installation.servicePointId, servicePointId), isNull(installation.removedAt), eq(meter.kind, "customer")))
    .limit(1);
  return row ?? null;
}

/**
 * Records the final reading of a disconnection. `id` is derived by the caller from the
 * disconnection event, so a retry returns the same reading (M-04).
 */
export function recordFinalReading(
  env: UserActionEnv,
  input: { id: string; meterId: string; value: number; readAt: Date; rolloverConfirmed?: boolean; note?: string },
): Promise<Recorded> {
  return recordReading(
    env,
    { id: input.id, meterId: input.meterId, value: input.value, readAt: input.readAt, quality: "good", note: input.note ?? "Final reading at disconnection", rolloverConfirmed: input.rolloverConfirmed ?? false },
    { source: "office", purpose: "final" },
  );
}
