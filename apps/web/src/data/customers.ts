import type { CustomerType } from "@flowless/shared-types";
import { notFound } from "next/navigation";
import { getCategories, getPlaceNames, orNull, requireAccounts, PAGE_SIZE } from "./accounts";
import { getApi } from "./session";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type CustomerRow = Awaited<ReturnType<Api["accounts"]["customers"]["list"]>>[number];
export type CustomerContact = Awaited<ReturnType<Api["accounts"]["customers"]["get"]>>["contacts"][number];

/**
 * Customers (C-01): a name, phone, email or id-number search, or the name-ordered list with
 * keyset paging. A scope-limited member sees the customers of the accounts they can see.
 */
export async function listCustomers(params: { q?: string | undefined; type?: CustomerType | undefined; after?: string | undefined } = {}) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const q = params.q?.trim();
  let rows: CustomerRow[];
  let nextCursor: string | null = null;
  if (q) {
    rows = (await api.accounts.customers.search({ q, limit: 100 })).filter((c) => !params.type || c.type === params.type);
  } else {
    const page = await api.accounts.customers.list({
      ...(params.type ? { type: params.type } : {}),
      ...(params.after ? { after: params.after } : {}),
      limit: PAGE_SIZE + 1,
    });
    rows = page.slice(0, PAGE_SIZE);
    if (page.length > PAGE_SIZE) nextCursor = rows.at(-1)?.id ?? null;
  }
  return { rows, nextCursor, searched: Boolean(q), canCreate: session.access.permissions.includes("accounts:create") };
}

/** One customer with every contact (placeholders marked) and their accounts. */
export async function getCustomerPage(id: string) {
  const session = await requireAccounts();
  const { api } = await getApi();
  const customer = await orNull(api.accounts.customers.get({ id }));
  if (!customer) notFound();
  const duplicates = await api.accounts.customers.duplicates({ customerId: id });
  return {
    customer,
    duplicates,
    canEdit: session.access.permissions.includes("accounts:update"),
    locale: session.organization.settings.locale,
  };
}

/** What the new account and new application forms offer: categories, places, membership classes and the next number. */
export async function getAccountFormOptions(permission: "accounts:create" = "accounts:create") {
  const session = await requireAccounts();
  if (!session.access.permissions.includes(permission)) notFound();
  const { api } = await getApi();
  const [categories, places, classes, preview] = await Promise.all([
    getCategories(),
    getPlaceNames(),
    api.accounts.memberships.classes(),
    api.accounts.nextNumberPreview(),
  ]);
  return {
    categories: categories.categories.filter((c) => c.active).map(({ id, name }) => ({ id, name })),
    showCategory: categories.licensed,
    areas: places.areas.map(({ id, name, level, parentId }) => ({ id, name, level, parentId })),
    routes: places.routes.map(({ id, name, code, areaId }) => ({ id, name: `${code} · ${name}`, areaId })),
    classes: classes.map(({ key, label }) => ({ key, label })),
    nextNumber: preview.next,
  };
}
export type AccountFormOptions = Awaited<ReturnType<typeof getAccountFormOptions>>;
