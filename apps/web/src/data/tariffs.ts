import { notFound } from "next/navigation";
import { draftFromContent, type Content } from "@/lib/tariff-content";
import { orNull } from "./accounts";
import { listPeople, nameOf } from "./people";
import { getApi, requireModule } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type TariffRow = Awaited<ReturnType<Api["tariffs"]["list"]>>[number];
export type TariffDetail = Awaited<ReturnType<Api["tariffs"]["get"]>>;
export type CategoryRow = Awaited<ReturnType<Api["tariffs"]["categories"]["list"]>>[number];
export type CategoryDetail = Awaited<ReturnType<Api["tariffs"]["categories"]["get"]>>;
export type ChargeItemRow = Awaited<ReturnType<Api["tariffs"]["chargeItems"]["list"]>>[number];
export type ChargeItemDetail = Awaited<ReturnType<Api["tariffs"]["chargeItems"]["get"]>>;
export type InvoiceTypeRow = Awaited<ReturnType<Api["tariffs"]["invoiceTypes"]["list"]>>[number];
export type InvoiceTypeDetail = Awaited<ReturnType<Api["tariffs"]["invoiceTypes"]["get"]>>;

/** Tariffs is licensed and the member may read it; anything else is not found (K-03, K-04). */
export const requireTariffs = () => requireModule("tariffs", "tariffs:read");

const canManage = (session: Awaited<ReturnType<typeof requireTariffs>>) => session.access.permissions.includes("tariffs:manage");

/** The organization's currency and formatting, for money and dates on every Tariffs screen. */
const formatting = (session: Awaited<ReturnType<typeof requireTariffs>>) => ({
  currency: session.organization.settings.currency,
  locale: session.organization.settings.locale,
  timeZone: session.organization.settings.timeZone,
});

/** The date a change made now would take effect, with the policy and closed-period limit (T-03). */
async function nextEffective(api: Api) {
  return api.tariffs.nextEffectiveDate();
}

/* ---------- tariffs (T-01) ---------- */

/** The tariffs list: type, the version in force and the next scheduled one. */
export async function listTariffs() {
  const session = await requireTariffs();
  const { api } = await getApi();
  const [rows, next] = await Promise.all([api.tariffs.list(), nextEffective(api)]);
  return { rows, today: next.today, canManage: canManage(session), ...formatting(session) };
}

/** Everything the tariff page shows: the versions with content, who made each, and the date a new one would start. */
export async function getTariffPage(id: string) {
  const session = await requireTariffs();
  const { api } = await getApi();
  const [tariff, next, people] = await Promise.all([orNull(api.tariffs.get({ id })), nextEffective(api), listPeople()]);
  if (!tariff) notFound();
  const fmt = formatting(session);
  const latest = tariff.inForce ?? tariff.versions.at(-1) ?? null;
  return {
    tariff,
    next,
    versions: tariff.versions.map((v) => ({ ...v, by: nameOf(people, v.createdByUserId) ?? "A colleague" })),
    /** The form for a new version starts from the content in force (or the latest), as typed text. */
    seedDraft: latest ? draftFromContent(latest.content as Content, fmt.currency) : null,
    existingDates: tariff.versions.map((v) => v.effectiveFrom),
    canManage: canManage(session),
    ...fmt,
  };
}

/** The new-tariff form: the date a first version would start and the formatting. */
export async function getNewTariffForm() {
  const session = await requireModule("tariffs", "tariffs:manage");
  const { api } = await getApi();
  return { next: await nextEffective(api), ...formatting(session) };
}

/* ---------- categories (T-02) ---------- */

/** Categories (active and not) with what they are priced with now, their history, and the choices an assignment offers. */
export async function getCategoriesPage() {
  const session = await requireTariffs();
  const { api } = await getApi();
  const [categories, allTariffs, allItems, next, people] = await Promise.all([
    api.tariffs.categories.list({ includeInactive: true }),
    api.tariffs.list(),
    api.tariffs.chargeItems.list(),
    nextEffective(api),
    listPeople(),
  ]);
  const details = await Promise.all(categories.map((c) => api.tariffs.categories.get({ id: c.id })));
  const tariffs = allTariffs.filter((t) => t.active);
  const items = allItems.filter((i) => i.active);
  const tariffNames = new Map(allTariffs.map((t) => [t.id, t.name]));
  const itemNames = new Map(allItems.map((i) => [i.id, i.name]));
  return {
    categories: details.map((c) => ({
      ...c,
      history: c.history.map((a) => ({ ...a, by: nameOf(people, a.createdByUserId) ?? "A colleague" })),
    })),
    tariffs: tariffs.map((t) => ({ id: t.id, name: t.name })),
    standing: items.filter((i) => i.type === "recurring").map((i) => ({ id: i.id, name: i.name, code: i.code })),
    discounts: items.filter((i) => i.type === "adjustment").map((i) => ({ id: i.id, name: i.name, code: i.code })),
    tariffNames: Object.fromEntries(tariffNames),
    itemNames: Object.fromEntries(itemNames),
    next,
    canManage: canManage(session),
    ...formatting(session),
  };
}

/* ---------- the charge catalog (T-07) ---------- */

/** Charge items with their amount history. */
export async function getChargeCatalog() {
  const session = await requireTariffs();
  const { api } = await getApi();
  const [items, next, people] = await Promise.all([api.tariffs.chargeItems.list(), nextEffective(api), listPeople()]);
  const details = await Promise.all(items.map((i) => api.tariffs.chargeItems.get({ id: i.id })));
  return {
    items: details.map((d) => ({ ...d, amounts: d.amounts.map((a) => ({ ...a, by: nameOf(people, a.createdByUserId) ?? "A colleague" })) })),
    next,
    canManage: canManage(session),
    ...formatting(session),
  };
}

/* ---------- invoice types (T-08 to T-10) ---------- */

export async function listInvoiceTypes() {
  const session = await requireTariffs();
  const { api } = await getApi();
  const rows = await api.tariffs.invoiceTypes.list();
  return { rows, canManage: canManage(session), ...formatting(session) };
}

export async function getInvoiceTypePage(id: string) {
  const session = await requireTariffs();
  const { api } = await getApi();
  const [type, items] = await Promise.all([orNull(api.tariffs.invoiceTypes.get({ id })), api.tariffs.chargeItems.list()]);
  if (!type) notFound();
  return {
    type,
    chargeItems: items.map((i) => ({ code: i.code, name: i.name, type: i.type, active: i.active, amount: i.amount?.amount ?? null })),
    canManage: canManage(session),
    ...formatting(session),
  };
}
