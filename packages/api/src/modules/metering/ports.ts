import { installation, meter } from "@flowless/db/schema/metering";
import { and, eq, isNull, sql } from "drizzle-orm";
import { systemEnv } from "../../kernel/action-env";
import { raiseException } from "../../kernel/exception-store";
import { defineConsumer } from "../../kernel/events";
import { registerDataQualitySource, registerGateSource, registerReadingHandover, servicePointOwners, servicePointRelocated, type DataQualitySource, type GateSource } from "../accounts";
import { readingHandoverPort } from "./handover";
import { installMeter, removeMeter } from "./installations";
import { derivedId } from "./outcomes";
import { readingsFor } from "./reads";

/*
 * What Metering tells Accounts (NF-30, NF-31): the `initial_reading` activation gate, the
 * `active_metered_no_meter` data-quality source, the reading handover for succession and
 * change of name, and the meter closing and opening after a relocation. Each port is
 * registered with `requires: ["metering"]`, so an organization without Metering never asks
 * Metering anything and activation, data quality, succession and change of name behave as
 * they did before it existed.
 */

/** C-06: the account has a reading to start from: an initial reading, or any valid actual one. */
export const initialReadingSource: GateSource = async (tx, _organizationId, accountId) => {
  const readings = await readingsFor(tx, { accountId, actualOnly: true, order: "asc", limit: 20 });
  const first = readings.find((r) => r.purpose === "initial") ?? readings[0];
  return first ? { met: true, detail: `Reading ${first.value} on ${first.readAt.toISOString().slice(0, 10)}` } : { met: false, detail: "No reading has been taken yet" };
};

/**
 * C-12: accounts that have a service point which once had a customer meter and has none now
 * and is still in use. "Metered" is read from the history of installations, because Metering
 * cannot see Accounts' billing basis; an account never given a meter is not found here.
 */
export const activeMeteredNoMeter: DataQualitySource = async (tx) => {
  const rows = await tx.execute<{ service_point_id: string }>(sql`
    select distinct i.service_point_id from metering.installation i
      join metering.meter m on m.organization_id = i.organization_id and m.id = i.meter_id and m.kind = 'customer'
     where i.removed_at is not null
       and not exists (select 1 from metering.installation o where o.organization_id = i.organization_id and o.service_point_id = i.service_point_id and o.removed_at is null)`);
  const owners = await servicePointOwners(tx, rows.map((r) => r.service_point_id));
  return owners.filter((o) => o.live).map((o) => o.accountId);
};

/** A dial reading entered as text on a relocation; null when it is not a whole number. */
function dialValue(text: string | null): number | null {
  const t = text?.trim();
  return t && /^\d{1,15}$/.test(t) ? Number(t) : null;
}

/**
 * C-09: after a relocation the meter at the old place is closed (removed with the final
 * reading, when the relocation recorded one as a number) and the same meter is opened at the
 * new place with the initial reading, when one was recorded. Without an initial reading the
 * meter goes back to stock and a queue item asks for a meter at the new place. Idempotent:
 * ids are derived from the Accounts command, so a replay changes nothing. The relocation
 * event has no meter, so the meter is the one installed at the old service point.
 */
export const closeAndOpenOnRelocation = defineConsumer({
  name: "metering.close_and_open_on_relocation",
  module: "metering",
  event: servicePointRelocated,
  async handle(ctx, e) {
    const env = systemEnv(ctx.tx, ctx.organizationId);
    const [open] = await ctx.tx
      .select({ meterId: installation.meterId })
      .from(installation)
      .innerJoin(meter, and(eq(meter.organizationId, installation.organizationId), eq(meter.id, installation.meterId)))
      .where(and(eq(installation.servicePointId, e.fromServicePointId), isNull(installation.removedAt), eq(meter.kind, "customer")));
    if (!open) return;
    const at = new Date(e.occurredAt);
    const finalValue = dialValue(e.finalReading);
    const initialValue = dialValue(e.initialReading);
    const entry = (value: number, seed: string) => ({ id: derivedId(seed), value, source: "office" as const, quality: "good" as const, note: "Relocation", rolloverConfirmed: false });
    await removeMeter(env, {
      id: derivedId(`relocation:${e.commandId}:remove`),
      meterId: open.meterId,
      removedAt: at,
      to: "in_stock",
      reason: "Relocated: the account moved to a new service point",
      ...(finalValue !== null ? { finalReading: entry(finalValue, `relocation:${e.commandId}:final`) } : {}),
    });
    if (initialValue !== null) {
      await installMeter(env, {
        id: derivedId(`relocation:${e.commandId}:install`),
        meterId: open.meterId,
        servicePointId: e.toServicePointId,
        installedAt: at,
        initialReading: entry(initialValue, `relocation:${e.commandId}:initial`),
      });
    } else {
      await raiseException(ctx.tx, ctx.organizationId, {
        type: "READING_EXCEPTION",
        source: "metering",
        title: "Install a meter at the new service point",
        detail: `Account ${e.number} moved; the meter was taken off the old service point and no initial reading was recorded for the new one.`,
        subject: { kind: "account", ref: e.accountId },
        dedupeKey: `relocation-meter:${e.toServicePointId}`,
      });
    }
    await env.audit({ action: "metering.relocation_meters", subjectType: "service_point", subjectId: e.toServicePointId, after: { fromServicePointId: e.fromServicePointId, meterId: open.meterId, reopened: initialValue !== null } });
  },
});

/** Registers all of Metering's ports with Accounts; called by `registerKernel`, replaces earlier registrations. */
export function registerPorts(): void {
  registerGateSource("initial_reading", initialReadingSource, { requires: ["metering"] });
  registerDataQualitySource("active_metered_no_meter", activeMeteredNoMeter, { requires: ["metering"] });
  registerReadingHandover(readingHandoverPort, { requires: ["metering"] });
}
