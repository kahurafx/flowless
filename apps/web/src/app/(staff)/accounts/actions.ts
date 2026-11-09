"use server";

import { findAccounts } from "@/data/accounts";
import { runAction, type Api } from "@/data/run-action";
import { parseMinorUnits } from "@/lib/account-forms";

/*
 * Server actions for the Accounts screens (C-01 to C-12). Each is one change as the signed-in
 * member through `runAction`: the procedures check licence, permission and scope, a refusal
 * comes back as the dialog's error. Status commands, applications and relocations carry a
 * client-minted `id` (minted once per dialog opening in the browser), so a retried submit
 * replays instead of acting twice.
 */

type In<F> = F extends (input: infer I) => unknown ? I : never;
type Accounts = Api["accounts"];

/* ---------- search and previews (no refresh) ---------- */

export const searchAccountsAction = async (q: string) => runAction(() => findAccounts(q), { refresh: false });

export const searchCustomersAction = async (q: string) => runAction((api) => api.accounts.customers.search({ q, limit: 8 }), { refresh: false });

export const findDuplicatesAction = async (input: In<Accounts["customers"]["duplicates"]>) =>
  runAction((api) => api.accounts.customers.duplicates(input), { refresh: false });

export const searchParentsAction = async (q: string) =>
  runAction(async (api) => (await api.accounts.search({ q, limit: 8 })).filter((a) => a.parentAccountId === null && a.commercialStatus !== "TERMINATED"), {
    refresh: false,
  });

export const previewNumberAction = async (parentAccountId: string | null) =>
  runAction((api) => api.accounts.nextNumberPreview(parentAccountId ? { parentAccountId } : undefined), { refresh: false });

/* ---------- customers and contacts ---------- */

export const createCustomerAction = async (input: In<Accounts["customers"]["create"]>) =>
  runAction(async (api) => (await api.accounts.customers.create(input)).id, { refresh: false });

export const updateCustomerAction = async (input: In<Accounts["customers"]["update"]>) => runAction((api) => api.accounts.customers.update(input).then(() => null));

export const addContactAction = async (input: In<Accounts["contacts"]["add"]>) => runAction((api) => api.accounts.contacts.add(input).then(() => null));

export const updateContactAction = async (input: In<Accounts["contacts"]["update"]>) => runAction((api) => api.accounts.contacts.update(input).then(() => null));

export const removeContactAction = async (id: string) => runAction((api) => api.accounts.contacts.remove({ id }).then(() => null));

/* ---------- opening an account ---------- */

export const createAccountAction = async (input: In<Accounts["create"]>) =>
  runAction(async (api) => {
    const created = await api.accounts.create(input);
    return { id: created.id, number: created.number };
  }, { refresh: false });

export const createServicePointAction = async (input: In<Accounts["servicePoints"]["create"]>) =>
  runAction((api) => api.accounts.servicePoints.create(input).then((sp) => sp.id));

/* ---------- lifecycle (C-03, C-04, C-06, C-11) ---------- */

type Base = { id: string; accountId: string; reason: string; note?: string };

export type LifecycleRequest =
  | ({ kind: "mark_pending_payment" | "make_dormant" | "reactivate" | "disconnect_service" | "reconnect_service" } & Base)
  | ({ kind: "terminate"; approvalId?: string; acknowledgeNoLedger?: boolean } & Base)
  | ({ kind: "activate"; override?: boolean; connect?: boolean; serviceReason?: string } & Base);

export async function runLifecycle(request: LifecycleRequest) {
  // The procedures take the request without its `kind`; extra keys are stripped by their input schema.
  return runAction(async (api) => {
    switch (request.kind) {
      case "mark_pending_payment":
        return (await api.accounts.markPendingPayment(request)).command.id;
      case "make_dormant":
        return (await api.accounts.makeDormant(request)).command.id;
      case "reactivate":
        return (await api.accounts.reactivate(request)).command.id;
      case "disconnect_service":
        return (await api.accounts.disconnectService(request)).command.id;
      case "reconnect_service":
        return (await api.accounts.reconnectService(request)).command.id;
      case "terminate":
        return (await api.accounts.terminate(request)).command.id;
      case "activate":
        return (await api.accounts.activate(request)).command.id;
    }
  });
}

export const tickGateAction = async (accountId: string, gateKey: string, note: string) =>
  runAction((api) => api.accounts.activation.tick({ accountId, gateKey, ...(note.trim() ? { note: note.trim() } : {}) }).then((s) => s.activated));

export const untickGateAction = async (accountId: string, gateKey: string, note: string) =>
  runAction((api) => api.accounts.activation.untick({ accountId, gateKey, ...(note.trim() ? { note: note.trim() } : {}) }).then(() => null));

/** The write-off asks for approval (K-05); the amount is typed as money and becomes minor units here. */
export async function requestWriteOffAction(input: { accountId: string; amountText: string; reasonCode: string; note: string }) {
  const amount = parseMinorUnits(input.amountText);
  if (amount === null) return { error: "Enter the balance to write off as an amount, like 1250.00" } as const;
  return runAction((api) => api.accounts.requestWriteOff({ accountId: input.accountId, amount, reasonCode: input.reasonCode, note: input.note }).then((r) => r.status));
}

/* ---------- succession, change of name, relocation (C-08 to C-10) ---------- */

export const succeedAction = async (input: In<Accounts["succeed"]>) => runAction((api) => api.accounts.succeed(input).then((r) => r.command.id));

export const changeNameAction = async (input: In<Accounts["changeName"]>) => runAction((api) => api.accounts.changeName(input).then((r) => r.command.id));

export const requestRelocationAction = async (input: In<Accounts["relocations"]["request"]>) =>
  runAction((api) => api.accounts.relocations.request(input).then(() => null));

export const recordRelocationSurveyAction = async (input: In<Accounts["relocations"]["recordSurvey"]>) =>
  runAction((api) => api.accounts.relocations.recordSurvey(input).then(() => null));

export const recordRelocationWorkAction = async (input: In<Accounts["relocations"]["recordWork"]>) =>
  runAction((api) => api.accounts.relocations.recordWork(input).then(() => null));

export const completeRelocationAction = async (input: In<Accounts["relocations"]["complete"]>) =>
  runAction((api) => api.accounts.relocations.complete(input).then(() => null));

export const cancelRelocationAction = async (input: In<Accounts["relocations"]["cancel"]>) =>
  runAction((api) => api.accounts.relocations.cancel(input).then(() => null));
