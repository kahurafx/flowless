import { withTenant, type Database, type Transaction } from "@flowless/db";
import { sql } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import { openDedupeKeys, raiseException, resolveByDedupeKey } from "../../kernel/exception-store";
import { activationSetting } from "./settings";
import { gatherFacts, hasGateSource } from "./sources";

/*
 * The stale-account sweep (C-06, X-02), run by `apps/worker` once a minute beside the
 * work-order SLA sweep. Two things go to the exception queue, once each per account:
 *  - STALE_ACTIVATION: an account in NEW or PENDING_PAYMENT for more than
 *    `accounts.activation.staleAfterDays` (default 14), counted from when it entered that status;
 *  - ACCOUNT_NOT_ACTIVE_WITH_METER: a NEW or PENDING_PAYMENT account that the gate sources say has
 *    a meter installed and an initial reading (so it is being read but not billed). Only
 *    when both sources are registered and licensed; without them nothing is known.
 * Each is resolved by itself when the account leaves NEW and PENDING_PAYMENT (or the
 * condition stops being true). Owner: whoever opened the account. Returns how many were raised.
 */

export const staleKey = (accountId: string) => `account_stale:${accountId}`;
export const meterKey = (accountId: string) => `account_not_active_with_meter:${accountId}`;
const STALE_PREFIX = "account_stale:";
const METER_PREFIX = "account_not_active_with_meter:";

type Candidate = {
  id: string;
  number: string;
  commercial_status: "NEW" | "PENDING_PAYMENT";
  created_by_user_id: string;
  since: Date | string;
  area_id: string | null;
  route_id: string | null;
};

const DAY_MS = 86_400_000;

export async function sweepStaleAccounts(db: Database, { batch = 50 }: { batch?: number } = {}): Promise<number> {
  let raised = 0;
  let after: string | null = null;
  for (;;) {
    const orgs: { organization_id: string }[] = await db.execute(sql`select * from accounts.sweep_organizations(${after}::uuid, ${batch})`);
    for (const { organization_id: organizationId } of orgs) {
      raised += await withTenant(db, organizationId, (tx) => sweepOrganization(tx, organizationId));
    }
    if (orgs.length < batch) return raised;
    after = orgs[orgs.length - 1]!.organization_id;
  }
}

async function sweepOrganization(tx: Transaction, organizationId: string): Promise<number> {
  const config = (await readSetting(tx, activationSetting)).value;
  const now = Date.now();
  const candidates = await tx.execute<Candidate>(sql`
    select a.id, a.number, a.commercial_status, a.created_by_user_id,
           coalesce(
             (select max(c.occurred_at) from accounts.account_command c
               where c.account_id = a.id and c.to_commercial_status = a.commercial_status and c.from_commercial_status <> a.commercial_status),
             a.opened_at
           ) as since,
           sp.area_id, sp.route_id
      from accounts.account a
      left join lateral (
        select coalesce(p.dma_id, p.zone_id, p.scheme_id) as area_id, p.route_id
          from accounts.service_point p where p.account_id = a.id order by p.created_at, p.id limit 1
      ) sp on true
     where a.commercial_status in ('NEW', 'PENDING_PAYMENT')
     order by a.opened_at, a.id`);

  let raised = 0;

  // Stale: long enough in the status.
  const openStale = await openDedupeKeys(tx, STALE_PREFIX);
  const stale = new Set<string>();
  for (const c of candidates) {
    const days = Math.floor((now - new Date(c.since).getTime()) / DAY_MS);
    if (days < config.staleAfterDays) continue;
    stale.add(c.id);
    if (openStale.has(staleKey(c.id))) continue;
    await raiseException(tx, organizationId, {
      type: "STALE_ACTIVATION",
      source: "accounts",
      title: `Stuck in ${c.commercial_status}: account ${c.number}`,
      detail: `Account ${c.number} has been ${c.commercial_status.toLowerCase().replace("_", " ")} for ${days} days (limit ${config.staleAfterDays}). Activate it, or terminate it if it will not go ahead.`,
      subject: { kind: "account", ref: c.number },
      areaId: c.area_id,
      routeId: c.route_id,
      ownerUserId: c.created_by_user_id,
      dedupeKey: staleKey(c.id),
    });
    raised += 1;
  }
  for (const key of openStale) {
    if (!stale.has(key.slice(STALE_PREFIX.length))) await resolveByDedupeKey(tx, key, "The account is no longer stale: it left new and pending payment");
  }

  // A meter installed and read, but the account is not active.
  const withMeter = new Set<string>();
  const openMeter = await openDedupeKeys(tx, METER_PREFIX);
  if (hasGateSource("meter_installed") && hasGateSource("initial_reading")) {
    for (const c of candidates) {
      const facts = await gatherFacts(tx, organizationId, c.id, ["meter_installed", "initial_reading"]);
      if (!facts.meter_installed?.met || !facts.initial_reading?.met) continue;
      withMeter.add(c.id);
      if (openMeter.has(meterKey(c.id))) continue;
      await raiseException(tx, organizationId, {
        type: "ACCOUNT_NOT_ACTIVE_WITH_METER",
        source: "accounts",
        title: `Meter installed and read, account not active: ${c.number}`,
        detail: `Account ${c.number} is ${c.commercial_status.toLowerCase().replace("_", " ")} but has a meter installed and an initial reading. Check what is holding activation back.`,
        subject: { kind: "account", ref: c.number },
        areaId: c.area_id,
        routeId: c.route_id,
        ownerUserId: c.created_by_user_id,
        dedupeKey: meterKey(c.id),
      });
      raised += 1;
    }
  }
  for (const key of openMeter) {
    if (!withMeter.has(key.slice(METER_PREFIX.length))) await resolveByDedupeKey(tx, key, "The account is active, or no longer has a meter installed and read");
  }
  return raised;
}
