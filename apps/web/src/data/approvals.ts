import { getApi, getSession } from "./session";
import { listPeople, nameOf } from "./people";

type Api = Awaited<ReturnType<typeof getApi>>["api"];
export type ApprovalView = "to_decide" | "open" | "closed";
export type ApprovalRow = Awaited<ReturnType<Api["approvals"]["list"]>>[number] & { requester: string };

/**
 * Approval requests the member is involved in (K-05): what waits for their decision, what is
 * open, and what has been decided. The kernel scopes and gates it; any member may open it.
 */
export async function listApprovals(view: ApprovalView) {
  const [{ api }, session, people] = await Promise.all([getApi(), getSession(), listPeople()]);
  const rows = await api.approvals.list({ view });
  return {
    rows: rows.map((r): ApprovalRow => ({ ...r, requester: nameOf(people, r.requestedByUserId) ?? "A colleague" })),
    currency: session.organization.settings.currency,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
