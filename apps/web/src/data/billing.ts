import { notFound } from "next/navigation";
import { connection } from "next/server";
import { orNull, requireAccounts } from "./accounts";
import { listPeople, nameOf } from "./people";
import { getApi, getSession } from "./session";
import { reversedIds } from "@/lib/billing-view";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type DocumentRow = Awaited<ReturnType<Api["billing"]["documents"]["list"]>>[number];
export type DocumentDetail = Awaited<ReturnType<Api["billing"]["documents"]["get"]>>;
export type StatementItem = Awaited<ReturnType<Api["billing"]["statement"]>>["items"][number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATEMENT_LIMIT = 1000;
const DOCUMENT_LIMIT = 200;

/** Billing is licensed (K-04) and the member holds `billing:read` (K-03): the statement is shown, hidden or explained accordingly. */
export type BillingAccess = "ready" | "unlicensed" | "forbidden";

export async function billingAccess(): Promise<{ state: BillingAccess; canAdjust: boolean; canExceptions: boolean; currency: string; locale: string; timeZone: string }> {
  const { organization, access } = await getSession();
  const has = (p: string) => access.permissions.some((x) => x === p);
  const state: BillingAccess = !organization.entitlements.includes("billing") ? "unlicensed" : has("billing:read") ? "ready" : "forbidden";
  return {
    state,
    canAdjust: state === "ready" && has("billing:adjust"),
    canExceptions: has("exceptions:read"),
    currency: organization.settings.currency,
    locale: organization.settings.locale,
    timeZone: organization.settings.timeZone,
  };
}

/** The account's balance, statement (running total over the whole history), documents and its adjustment requests (B-11, B-17, K-05). */
export async function getAccountStatement(accountId: string) {
  await connection();
  const access = await billingAccess();
  if (access.state !== "ready") return { access, data: null };
  const { api } = await getApi();
  const [balance, statement, documents, approvals] = await Promise.all([
    api.billing.balance({ accountId }),
    api.billing.statement({ accountId, limit: STATEMENT_LIMIT }),
    api.billing.documents.list({ accountId, limit: DOCUMENT_LIMIT }),
    access.canAdjust ? Promise.all([api.approvals.list({ view: "open" }), api.approvals.list({ view: "closed" })]).then((l) => l.flat()) : Promise.resolve([]),
  ]);
  return {
    access,
    data: {
      balance,
      statement,
      truncated: statement.items.length >= STATEMENT_LIMIT,
      documents: new Map(documents.map((d) => [d.id, d])),
      reversed: reversedIds(documents),
      adjustments: approvals
        .filter((a) => a.kind === "billing.adjustment" && a.subjectRef.includes(`:${accountId}:`))
        .map((a) => ({ id: a.id, status: a.status, kind: a.subjectRef.split(":")[0] ?? "", amount: a.amount, reason: a.reasonLabel, requestedAt: a.requestedAt })),
    },
  };
}
export type AccountStatement = NonNullable<Awaited<ReturnType<typeof getAccountStatement>>["data"]>;

/** One document with its lines, the documents it is linked to and the tariff versions its lines cite (T-04). */
export async function getDocumentPage(number: string, id: string) {
  await connection();
  const [session] = await Promise.all([requireAccounts(), getSession()]);
  const access = await billingAccess();
  if (access.state !== "ready" || !UUID.test(id)) notFound();
  const { api } = await getApi();
  const [account, doc] = await Promise.all([orNull(api.accounts.get({ number })), orNull(api.billing.documents.get({ id }))]);
  if (!account || !doc || doc.accountId !== account.id) notFound();

  const linkIds = [doc.relatedDocumentId, doc.reversesDocumentId, doc.replacesDocumentId, doc.reversedByDocumentId, doc.replacedByDocumentId].filter((x): x is string => !!x);
  const people = await listPeople();
  const linked = await Promise.all([...new Set(linkIds)].map(async (l) => [l, await orNull(api.billing.documents.get({ id: l }))] as const));
  const links = new Map(linked.flatMap(([l, d]) => (d ? [[l, { id: d.id, number: d.number, kind: d.kind }] as const] : [])));

  // Tariff versions: only when Tariffs is readable; otherwise the line shows a short id.
  const cited = new Set(doc.lines.flatMap((l) => (l.tariffVersionId ? [l.tariffVersionId] : [])));
  const versions = new Map<string, { tariffId: string; tariffName: string; versionNo: number; effectiveFrom: string }>();
  if (cited.size > 0 && session.access.permissions.includes("tariffs:read")) {
    const tariffs = await orNull(api.tariffs.list());
    for (const t of tariffs ?? []) {
      for (const v of await api.tariffs.versions({ tariffId: t.id })) {
        if (cited.has(v.id)) versions.set(v.id, { tariffId: t.id, tariffName: t.name, versionNo: v.versionNo, effectiveFrom: v.effectiveFrom });
      }
    }
  }
  return {
    account: { id: account.id, number: account.number, customerName: account.customerName, categoryId: account.categoryId },
    doc,
    links,
    versions,
    by: nameOf(people, doc.createdByUserId) ?? "A colleague",
    access,
  };
}
export type DocumentPage = Awaited<ReturnType<typeof getDocumentPage>>;
