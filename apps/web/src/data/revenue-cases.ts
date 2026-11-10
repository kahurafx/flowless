import { notFound } from "next/navigation";
import { connection } from "next/server";
import { accountLabels } from "./account-labels";
import { orNull } from "./accounts";
import { requireBilling } from "./billing-cycles";
import { listPeople, nameOf } from "./people";
import { getApi } from "./session";
import { CASE_KINDS } from "@/lib/case-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Revenue-protection cases (B-19), newest first, with the account each concerns. */
export async function listRevenueCases(params: { status?: string | undefined; kind?: string | undefined }) {
  await connection();
  const session = await requireBilling();
  const { api } = await getApi();
  const status = params.status === "open" || params.status === "resolved" ? params.status : undefined;
  const kind = CASE_KINDS.find((k) => k === params.kind);
  const cases = await api.billing.cases.list({ limit: 100, ...(status ? { status } : {}), ...(kind ? { kind } : {}) });
  const labels = await accountLabels(cases.map((c) => c.accountId));
  return {
    cases,
    labels: Object.fromEntries(labels),
    canRun: session.access.permissions.includes("billing:run"),
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}

/** One case with its evidence, the approvals asked for its back-billing and the invoice types a back-billing can post under. */
export async function getRevenueCase(id: string) {
  await connection();
  const session = await requireBilling();
  if (!UUID.test(id)) notFound();
  const { api } = await getApi();
  const found = await orNull(api.billing.cases.get({ caseId: id }));
  if (!found) notFound();
  const has = (p: string) => session.access.permissions.some((x) => x === p);
  const [labels, people, approvals, types, protection] = await Promise.all([
    accountLabels([found.accountId]),
    listPeople(),
    Promise.all([api.approvals.list({ view: "open" }), api.approvals.list({ view: "closed" })]).then((l) => l.flat()),
    session.organization.entitlements.includes("tariffs") && has("tariffs:read") ? api.tariffs.invoiceTypes.list() : Promise.resolve(null),
    has("settings:manage") ? api.config.list().then((l) => l.find((s) => s.key === "billing.revenue_protection")?.value ?? null) : Promise.resolve(null),
  ]);
  const subject = `correction:${found.accountId}:backbill:${id}`;
  return {
    case: found,
    label: labels.get(found.accountId) ?? null,
    actors: Object.fromEntries(found.events.map((e) => [e.id, nameOf(people, e.actorUserId) ?? "The system"])),
    approvals: approvals.filter((a) => a.kind === "billing.correction" && a.subjectRef === subject).map((a) => ({ id: a.id, status: a.status, amount: a.amount, requestedAt: a.requestedAt })),
    invoiceTypes: types ? types.filter((t) => t.active !== false).map((t) => ({ id: t.id, name: t.name })) : null,
    protection: protection as { backBillMaxMonths: number; backBillRequiresApproval: boolean } | null,
    canRun: has("billing:run"),
    currency: session.organization.settings.currency,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
export type CasePage = Awaited<ReturnType<typeof getRevenueCase>>;
