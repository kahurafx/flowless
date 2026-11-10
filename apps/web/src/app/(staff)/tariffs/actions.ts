"use server";

import type { ChargeRecurrence, ChargeType, FlatBasis, TariffType } from "@flowless/shared-types";
import { accountLabels } from "@/data/account-labels";
import { orNull } from "@/data/accounts";
import { runAction } from "@/data/run-action";
import { getApi, getSession } from "@/data/session";
import { parseAccountNumbers, selectionProblem } from "@/lib/simulation-view";
import { lateFeeFromDraft, linesFromDrafts, updateFromForm, type InvoiceTypeForm, type LateFeeDraft, type LineDraft } from "@/lib/invoice-type-form";
import { parseAmount } from "@/lib/money-input";
import { parseDraft, type ContentDraft } from "@/lib/tariff-content";
import type { AssignmentChoice } from "@/lib/tariff-view";
import { assignmentInput } from "@/lib/tariff-view";

/*
 * Server actions for the Tariffs screens (T-01 to T-10). Typed amounts arrive as text and
 * become minor units here, in the organization's currency, with the same pure parsers the
 * forms use for live checks; the procedures validate again and their refusals come back as
 * the dialog's message. The tariffs procedures need `tariffs:manage`; nothing is hidden by
 * the page alone.
 */

const currencyOf = async () => (await getSession()).organization.settings.currency;
const refused = (error: string): { error: string; data?: undefined } => ({ error });
const orUndefined = (text: string) => (text.trim() === "" ? undefined : text.trim());

/* ---------- tariffs (T-01, T-03) ---------- */

export async function createTariffAction(input: { name: string; type: TariffType; flatBasis: FlatBasis; draft: ContentDraft; effectiveFrom: string; note: string }) {
  const checked = parseDraft(input.draft, { type: input.type, flatBasis: input.type === "flat_rate" ? input.flatBasis : "none" }, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  return runAction((api) =>
    api.tariffs
      .create({
        name: input.name,
        type: input.type,
        ...(input.type === "flat_rate" ? { flatBasis: input.flatBasis } : {}),
        content: checked.content,
        ...(orUndefined(input.effectiveFrom) ? { effectiveFrom: input.effectiveFrom.trim() } : {}),
        ...(orUndefined(input.note) ? { note: input.note.trim() } : {}),
      })
      .then((t) => t.id),
  );
}

export async function addVersionAction(input: { tariffId: string; type: TariffType; flatBasis: FlatBasis; draft: ContentDraft; effectiveFrom: string; note: string }) {
  const checked = parseDraft(input.draft, { type: input.type, flatBasis: input.flatBasis }, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  return runAction((api) =>
    api.tariffs
      .addVersion({
        tariffId: input.tariffId,
        content: checked.content,
        ...(orUndefined(input.effectiveFrom) ? { effectiveFrom: input.effectiveFrom.trim() } : {}),
        ...(orUndefined(input.note) ? { note: input.note.trim() } : {}),
      })
      .then((v) => ({ versionNo: v.versionNo, effectiveFrom: v.effectiveFrom })),
  );
}

/**
 * T-06: prices recent billed consumption under the draft and under the tariff in force. Nothing is
 * written. The accounts are named by number and found through Accounts (scope applies); the API
 * needs `billing:read` and `tariffs:read` or `tariffs:manage`.
 */
export async function simulateTariffAction(input: { type: TariffType; flatBasis: FlatBasis; draft: ContentDraft; routeId: string; categoryId: string; accountNumbers: string; spans: number }) {
  if (input.type === "flat_rate") return refused("A flat-rate tariff does not price consumption, so it cannot be simulated");
  const checked = parseDraft(input.draft, { type: input.type, flatBasis: "none" }, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  const problem = selectionProblem(input);
  if (problem) return refused(problem);
  const { api } = await getApi();
  const numbers = parseAccountNumbers(input.accountNumbers);
  const found = await Promise.all(numbers.map(async (number) => [number, await orNull(api.accounts.get({ number }))] as const));
  const missing = found.filter(([, a]) => !a).map(([n]) => n);
  if (missing.length > 0) return refused(`No account ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " and more" : ""}, or outside the areas you can see`);
  const accountIds = found.flatMap(([, a]) => (a ? [a.id] : []));
  const result = await runAction(
    (a) =>
      a.billing.simulation.run({
        draft: { type: input.type, content: checked.content },
        ...(accountIds.length ? { accountIds } : {}),
        ...(input.routeId ? { routeId: input.routeId } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        spansPerAccount: Math.min(24, Math.max(1, input.spans)),
      }),
    { refresh: false },
  );
  if (result.error !== null) return result;
  const labels = await accountLabels(result.data.topMovers.map((m) => m.accountId));
  return { error: null, data: { ...result.data, labels: Object.fromEntries(labels) } } as const;
}

export const updateTariffAction = async (input: { id: string; name?: string; active?: boolean }) =>
  runAction((api) => api.tariffs.update({ id: input.id, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.active !== undefined ? { active: input.active } : {}) }).then(() => null));

/* ---------- categories (T-02) ---------- */

export const createCategoryAction = async (input: { code: string; name: string }) => runAction((api) => api.tariffs.categories.create({ code: input.code.trim(), name: input.name }).then((c) => c.id));

export const renameCategoryAction = async (input: { id: string; name: string }) => runAction((api) => api.tariffs.categories.update(input).then(() => null));

export const setCategoryActiveAction = async (input: { id: string; active: boolean }) =>
  runAction((api) => (input.active ? api.tariffs.categories.reactivate({ id: input.id }) : api.tariffs.categories.deactivate({ id: input.id })).then(() => null));

/** Points a category at a tariff, standing charge, meter rent and discount from a date; what is kept is left out. */
export const assignTariffAction = async (input: { categoryId: string; choice: AssignmentChoice; effectiveFrom: string; reason: string }) =>
  runAction((api) =>
    api.tariffs.categories
      .assignTariff({
        categoryId: input.categoryId,
        ...assignmentInput(input.choice),
        ...(orUndefined(input.effectiveFrom) ? { effectiveFrom: input.effectiveFrom.trim() } : {}),
        ...(orUndefined(input.reason) ? { reason: input.reason.trim() } : {}),
      })
      .then((a) => a.versionNo),
  );

/* ---------- the charge catalog (T-07) ---------- */

export async function createChargeItemAction(input: { code: string; name: string; type: ChargeType; recurrence: ChargeRecurrence; amount: string; effectiveFrom: string }) {
  const currency = await currencyOf();
  const priced = input.type !== "usage" && input.amount.trim() !== "";
  const amount = priced ? parseAmount(input.amount, currency, { allowZero: true }) : undefined;
  if (priced && amount === null) return refused("Enter the amount like 1500.00, or leave it empty to price it later");
  return runAction((api) =>
    api.tariffs.chargeItems
      .create({
        code: input.code.trim(),
        name: input.name,
        type: input.type,
        ...(input.type === "recurring" ? { recurrence: input.recurrence } : {}),
        ...(amount !== undefined && amount !== null ? { amount } : {}),
        ...(amount !== undefined && amount !== null && orUndefined(input.effectiveFrom) ? { effectiveFrom: input.effectiveFrom.trim() } : {}),
      })
      .then((i) => i.id),
  );
}

export const updateChargeItemAction = async (input: { id: string; name: string; recurrence?: ChargeRecurrence }) =>
  runAction((api) => api.tariffs.chargeItems.update({ id: input.id, name: input.name, ...(input.recurrence ? { recurrence: input.recurrence } : {}) }).then(() => null));

export async function addAmountVersionAction(input: { chargeItemId: string; amount: string; effectiveFrom: string; reason: string }) {
  const amount = parseAmount(input.amount, await currencyOf(), { allowZero: true });
  if (amount === null) return refused("Enter the amount like 1500.00");
  return runAction((api) =>
    api.tariffs.chargeItems
      .addAmountVersion({
        chargeItemId: input.chargeItemId,
        amount,
        ...(orUndefined(input.effectiveFrom) ? { effectiveFrom: input.effectiveFrom.trim() } : {}),
        ...(orUndefined(input.reason) ? { reason: input.reason.trim() } : {}),
      })
      .then((a) => a.versionNo),
  );
}

export const setChargeItemActiveAction = async (input: { id: string; active: boolean }) =>
  runAction((api) => (input.active ? api.tariffs.chargeItems.reactivate({ id: input.id }) : api.tariffs.chargeItems.deactivate({ id: input.id })).then(() => null));

/* ---------- invoice types (T-08 to T-10) ---------- */

export async function updateInvoiceTypeAction(input: { id: string; appliesTo: "application" | "account"; form: InvoiceTypeForm }) {
  const checked = updateFromForm(input.form, input.appliesTo, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  return runAction((api) => api.tariffs.invoiceTypes.update({ id: input.id, ...checked.input }).then(() => null));
}

export async function setInvoiceLinesAction(input: { id: string; lines: LineDraft[] }) {
  const checked = linesFromDrafts(input.lines, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  return runAction((api) => api.tariffs.invoiceTypes.setLines({ id: input.id, lines: checked.input }).then(() => null));
}

export async function setLateFeeRuleAction(input: { id: string; draft: LateFeeDraft }) {
  const checked = lateFeeFromDraft(input.draft, await currencyOf());
  if (!checked.ok) return refused(checked.problems.join(". "));
  const rule = checked.input.rule;
  return runAction((api) => api.tariffs.invoiceTypes.setLateFeeRule({ id: input.id, rule }).then(() => null));
}

/** What a draft late-fee rule would charge, for the simulate panel: nothing is written, so the page is not refreshed. */
export async function simulateLateFeeAction(input: { draft: LateFeeDraft; balance: string; invoiceTotal: string; daysOverdue: string; alreadyCharged: string }) {
  const currency = await currencyOf();
  const rule = lateFeeFromDraft(input.draft, currency);
  if (!rule.ok) return refused(rule.problems.join(". "));
  if (rule.input.rule === null) return refused("Switch the rule on to simulate it");
  const balance = parseAmount(input.balance, currency, { allowZero: true });
  if (balance === null) return refused("Enter the overdue balance as an amount like 12000.00");
  const total = input.invoiceTotal.trim() === "" ? undefined : parseAmount(input.invoiceTotal, currency, { allowZero: true });
  if (total === null) return refused("Enter the invoice total as an amount, or leave it empty to use the balance");
  const already = input.alreadyCharged.trim() === "" ? 0n : parseAmount(input.alreadyCharged, currency, { allowZero: true });
  if (already === null) return refused("Enter the late fees already charged as an amount, or leave it empty");
  const days = /^\d+$/.test(input.daysOverdue.trim()) ? Number(input.daysOverdue.trim()) : null;
  if (days === null || days > 3650) return refused("Days overdue is a whole number from 0");
  const draftRule = rule.input.rule;
  return runAction(
    (api) =>
      api.tariffs
        .simulateLateFee({
          rule: draftRule,
          balance,
          ...(total !== undefined ? { invoiceTotal: total } : {}),
          daysOverdue: days,
          alreadyCharged: already,
        })
        .then((r) => ({ amount: r.amount, perApplication: r.perApplication, applications: r.applications, suggested: r.suggested, reason: r.reason })),
    { refresh: false },
  );
}
