import type { Transaction } from "@flowless/db";
import { sql } from "drizzle-orm";
import type { ActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { estimateCapReached, missThresholdReached, selfReadPromptDue, zeroConsumptionStreak } from "./events-policy";
import { meteringMissesSetting, meteringZeroSetting } from "./policy-settings";
import { readingsFor, type ReadingView } from "./reads";

/*
 * What the outcome history and the readings trigger (M-09, M-10): revisit, self-read prompt
 * and escalation after consecutive misses, the optional cap on consecutive estimates, and the
 * meter check after a zero-consumption streak. Counters are derived each time from the
 * attempts and readings, never stored; each action fires once, when its count is reached,
 * and its exception resolves itself when an actual reading arrives. A revisit "task" is an
 * exception for now: Work Orders publishes no way for another module to raise a job.
 */

const missKey = (kind: "revisit" | "escalate", servicePointId: string) => `miss:${kind}:${servicePointId}`;
const capKey = (servicePointId: string) => `estimate-cap:${servicePointId}`;
const zeroKey = (meterId: string) => `zero:${meterId}`;

/** The service point's placement, for the exceptions' owner queue. */
export interface Placement {
  servicePointId: string;
  accountId: string | null;
  areaId: string | null;
  routeId: string | null;
}

/**
 * M-09: visits with no reading since the last actual one, newest run only. The last actual is
 * the later of a `read_ok` visit and a valid non-estimate routine reading. Derived, not stored.
 */
export async function consecutiveMisses(tx: Transaction, servicePointId: string): Promise<number> {
  const rows = await tx.execute<{ n: string }>(sql`
    with last_ok as (
      select greatest(
        (select max(a.attempted_at) from metering.read_attempt a where a.service_point_id = ${servicePointId} and a.outcome = 'read_ok'),
        (select max(r.read_at) from metering.reading r
           join lateral (select s.status from metering.reading_status s where s.organization_id = r.organization_id and s.reading_id = r.id order by s.seq desc limit 1) s on true
          where r.service_point_id = ${servicePointId} and r.source <> 'estimate' and r.purpose = 'routine' and s.status = 'valid')
      ) as at)
    select count(*)::text as n from metering.read_attempt a, last_ok
     where a.service_point_id = ${servicePointId} and a.outcome <> 'read_ok' and (last_ok.at is null or a.attempted_at > last_ok.at)`);
  return Number(rows[0]?.n ?? 0);
}

/** M-09 (S): estimates since the last actual reading of the service point. Derived. */
export async function consecutiveEstimates(tx: Transaction, servicePointId: string): Promise<number> {
  const rows = await tx.execute<{ n: string }>(sql`
    with valid as (
      select r.source, r.read_at from metering.reading r
        join lateral (select s.status from metering.reading_status s where s.organization_id = r.organization_id and s.reading_id = r.id order by s.seq desc limit 1) s on true
       where r.service_point_id = ${servicePointId} and s.status = 'valid'),
    last_actual as (select max(read_at) as at from valid where source <> 'estimate')
    select count(*)::text as n from valid, last_actual where valid.source = 'estimate' and (last_actual.at is null or valid.read_at > last_actual.at)`);
  return Number(rows[0]?.n ?? 0);
}

/** After a visit with no reading: raise what the count calls for. `count` is the counter including this visit. */
export async function applyMissPolicy(env: ActionEnv, at: Placement, count: number, cycleDate: string | null): Promise<void> {
  const cfg = (await readSetting(env.tx, meteringMissesSetting)).value;
  const subject = { kind: "account" as const, ref: at.accountId ?? at.servicePointId };
  const place = { areaId: at.areaId, routeId: at.routeId, ownerUserId: env.actor.userId };
  if (cfg.revisitAfter && count === cfg.revisitAfter) {
    await raiseException(env.tx, env.organizationId, {
      type: "READING_EXCEPTION",
      source: "metering",
      title: `Revisit needed: ${count} visits in a row without a reading`,
      detail: "No reading was obtained on the last visits; send someone back.",
      subject,
      ...place,
      dedupeKey: missKey("revisit", at.servicePointId),
    });
    await env.publish(missThresholdReached, { servicePointId: at.servicePointId, accountId: at.accountId, consecutiveMisses: count, action: "revisit" });
  }
  if (cfg.selfReadPromptAfter && count === cfg.selfReadPromptAfter) {
    await env.publish(selfReadPromptDue, { servicePointId: at.servicePointId, accountId: at.accountId, consecutiveMisses: count, cycleDate });
  }
  if (cfg.escalateAfter && count === cfg.escalateAfter) {
    await raiseException(env.tx, env.organizationId, {
      type: "READING_EXCEPTION",
      source: "metering",
      title: `Escalation: ${count} visits in a row without a reading`,
      detail: "The meter has not been read for several visits; a supervisor should decide what to do.",
      subject,
      ...place,
      dedupeKey: missKey("escalate", at.servicePointId),
    });
    await env.publish(missThresholdReached, { servicePointId: at.servicePointId, accountId: at.accountId, consecutiveMisses: count, action: "escalate" });
  }
}

/** What a recorded reading triggers: an actual one resets the counters; an estimate may hit the cap; a zero streak opens a meter check. */
export async function applyReadingPolicy(env: ActionEnv, view: ReadingView, at: Placement): Promise<void> {
  const subjectOf = { kind: "account" as const, ref: at.accountId ?? at.servicePointId };
  if (view.kind === "estimate") {
    const cap = (await readSetting(env.tx, meteringMissesSetting)).value.maxConsecutiveEstimates;
    if (cap === null) return;
    const count = await consecutiveEstimates(env.tx, at.servicePointId);
    if (count === cap) {
      await raiseException(env.tx, env.organizationId, {
        type: "READING_EXCEPTION",
        source: "metering",
        title: `${count} estimates in a row without an actual reading`,
        detail: `The cap on consecutive estimates is ${cap}.`,
        subject: subjectOf,
        areaId: at.areaId,
        routeId: at.routeId,
        ownerUserId: env.actor.userId,
        dedupeKey: capKey(at.servicePointId),
      });
      await env.publish(estimateCapReached, { servicePointId: at.servicePointId, accountId: at.accountId, consecutiveEstimates: count, cap });
    }
    return;
  }
  if (view.status !== "valid" || view.purpose !== "routine") return;
  await resolveByDedupeKey(env.tx, missKey("revisit", at.servicePointId), "A reading was obtained");
  await resolveByDedupeKey(env.tx, missKey("escalate", at.servicePointId), "A reading was obtained");
  await resolveByDedupeKey(env.tx, capKey(at.servicePointId), "An actual reading was recorded");

  if (!view.cleared) return;
  if (view.units !== null && view.units > 0) {
    await resolveByDedupeKey(env.tx, zeroKey(view.meterId), "Consumption is back");
    return;
  }
  if (view.units !== 0) return;
  const after = (await readSetting(env.tx, meteringZeroSetting)).value.streakAfter;
  if (!after) return;
  const recent = await readingsFor(env.tx, { meterId: view.meterId, actualOnly: true, clearedOnly: true, order: "desc", limit: after + 1 });
  let streak = 0;
  for (const r of recent) {
    if (r.purpose !== "routine" || r.units !== 0) break;
    streak++;
  }
  if (streak === after) {
    await raiseException(env.tx, env.organizationId, {
      type: "READING_EXCEPTION",
      source: "metering",
      title: `Meter check: ${streak} zero-consumption readings in a row`,
      detail: "The meter shows no consumption reading after reading; it may be stuck or the connection unused.",
      subject: { kind: "meter", ref: view.meterId },
      areaId: at.areaId,
      routeId: at.routeId,
      ownerUserId: env.actor.userId,
      dedupeKey: zeroKey(view.meterId),
    });
    await env.publish(zeroConsumptionStreak, { meterId: view.meterId, servicePointId: at.servicePointId, accountId: at.accountId, streak });
  }
}
