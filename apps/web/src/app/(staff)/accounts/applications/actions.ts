"use server";

import type { SurveyFeasibility } from "@flowless/shared-types";
import { runAction, type Api } from "@/data/run-action";

type In<F> = F extends (input: infer I) => unknown ? I : never;
type Applications = Api["accounts"]["applications"];

/** Logs an enquiry (C-05). The id is minted in the browser, so a retried submit replays. */
export const createApplicationAction = async (input: In<Applications["create"]>) =>
  runAction((api) => api.accounts.applications.create(input).then((r) => r.application.id));

export const recordSurveyAction = async (input: { id: string; applicationId: string; feasibility: SurveyFeasibility; findings: string; materialsNote: string }) =>
  runAction((api) =>
    api.accounts.applications
      .recordSurvey({
        id: input.id,
        applicationId: input.applicationId,
        feasibility: input.feasibility,
        findings: input.findings,
        ...(input.materialsNote.trim() ? { materialsNote: input.materialsNote.trim() } : {}),
      })
      .then((r) => r.approval?.status ?? null),
  );

export type AdvanceRequest =
  | { kind: "submit" | "installation" | "ready"; id: string; applicationId: string; reason?: string }
  | { kind: "invoiced"; id: string; applicationId: string; invoiceRef: string; reason?: string }
  | { kind: "paid"; id: string; applicationId: string; paymentRef: string; reason?: string };

export async function advanceApplicationAction(request: AdvanceRequest) {
  return runAction(async (api) => {
    const a = api.accounts.applications;
    switch (request.kind) {
      case "submit":
        return (await a.submitApplication(request)).application.stage;
      case "installation":
        return (await a.startInstallation(request)).application.stage;
      case "ready":
        return (await a.markReady(request)).application.stage;
      case "invoiced":
        return (await a.markInvoiced(request)).application.stage;
      case "paid":
        return (await a.markPaid(request)).application.stage;
    }
  });
}

/** Opens the account and its service point. Returns the new account's number to go to. */
export const convertApplicationAction = async (input: { id: string; applicationId: string }) =>
  runAction(async (api) => {
    const result = await api.accounts.applications.convert(input);
    const account = result.application.accountId ? await api.accounts.get({ id: result.application.accountId }) : null;
    return account?.number ?? null;
  });

export const endApplicationAction = async (input: { id: string; applicationId: string; reason: string; to: "rejected" | "cancelled" }) =>
  runAction((api) => {
    const { to, ...rest } = input;
    return (to === "rejected" ? api.accounts.applications.reject(rest) : api.accounts.applications.cancel(rest)).then((r) => r.application.stage);
  });
