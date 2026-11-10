import type { UserActionEnv } from "../../kernel/action-env";
import { plain } from "../../kernel/text";
import { documentIssued } from "./events";
import type { postDraft } from "./post";
import { documentFacts } from "./present";

/** Audit and event for a posted credit or debit note, citing the approval that allowed it. */
export async function announceNote(env: UserActionEnv, posted: Awaited<ReturnType<typeof postDraft>>, approvalId: string, reasonCode: string | null) {
  const d = posted.document;
  if (d.kind !== "credit_note" && d.kind !== "debit_note") throw new Error("Not a note");
  await env.audit({
    action: `billing.${d.kind}_issued`,
    subjectType: "document",
    subjectId: d.id,
    after: plain({ number: d.number, accountId: d.accountId, total: d.total, related: d.relatedDocumentId, approvalId, reasonCode }),
    reason: d.note ?? undefined,
  });
  await env.publish(documentIssued, { ...documentFacts(d, env.actor.userId), kind: d.kind, relatedDocumentId: d.relatedDocumentId, replacesDocumentId: null });
}
