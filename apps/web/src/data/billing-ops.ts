import { orNull } from "./accounts";
import { getApi, getSession } from "./session";

/**
 * What the account page needs to offer the Billing operations (B-09, B-12, B-13, B-14): the
 * disconnection and reconnection commands (billing:run and accounts:change_status), the
 * corrections preview and post (billing:read, billing:run) and the metered check that decides
 * whether the final dial is required. Null when Billing is not licensed or not readable.
 */
export async function getAccountOperations(account: { id: string; servicePointIds: readonly string[] }) {
  const { organization, access } = await getSession();
  const has = (p: string) => access.permissions.some((x) => x === p);
  if (!organization.entitlements.includes("billing") || !has("billing:read")) return null;
  const { api } = await getApi();

  const metering = organization.entitlements.includes("metering") && has("meters:read");
  const tariffs = organization.entitlements.includes("tariffs") && has("tariffs:read");
  const [installs, items, documents, approvals] = await Promise.all([
    metering ? Promise.all(account.servicePointIds.slice(0, 5).map((servicePointId) => api.metering.installations.list({ servicePointId, limit: 5 }))) : Promise.resolve([]),
    tariffs ? api.tariffs.chargeItems.list({ active: true }) : Promise.resolve(null),
    api.billing.documents.list({ accountId: account.id, kind: "invoice", limit: 24 }),
    Promise.all([api.approvals.list({ view: "open" }), api.approvals.list({ view: "closed" })]).then((l) => l.flat()),
  ]);
  const open = installs.flat().find((i) => i.removedAt === null) ?? null;
  const meter = open ? await orNull(api.metering.meters.get({ meterId: open.meterId })) : null;
  const periods = [...new Set(documents.flatMap((d) => (d.periodTo ? [d.periodTo.slice(0, 7)] : [])))];
  const corrections = approvals
    .filter((a) => a.kind === "billing.correction" && a.subjectRef.startsWith(`correction:${account.id}:`))
    .map((a) => ({ id: a.id, status: a.status, period: a.subjectRef.split(":")[2] ?? "", amount: a.amount }));

  return {
    canRun: has("billing:run"),
    canDisconnect: has("billing:run") && has("accounts:change_status"),
    meter: meter ? { serial: meter.meter.serial, dialDigits: meter.meter.dialDigits } : null,
    meteringLicensed: metering,
    feeItems: items ? items.filter((i) => i.type === "fee").map((i) => ({ id: i.id, name: i.name })) : null,
    periods,
    corrections,
    currency: organization.settings.currency,
    locale: organization.settings.locale,
  };
}
export type AccountOperations = NonNullable<Awaited<ReturnType<typeof getAccountOperations>>>;
