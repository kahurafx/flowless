import { account, accountCommand } from "@flowless/db/schema/accounts";
import { eq } from "drizzle-orm";
import { defineApproval, defineApprovalConsumer } from "../../kernel/approval-store";
import { systemEnv } from "../../kernel/action-env";
import { WRITE_OFF_KIND } from "./termination";

/**
 * Writing off a balance so that an account can be terminated (C-11, K-05). The default
 * policy has one level, holders of `billing:adjust` (the accountant and above); the
 * organization changes levels, thresholds and SLA in `approvals.accounts.write_off`. The
 * request's subject is the account id and its amount the balance to write off; terminating
 * cites the approved request (`terminate` with `approvalId`).
 */
export const writeOffApproval = defineApproval({
  key: WRITE_OFF_KIND,
  module: "accounts",
  label: "Write off an account balance",
  description: "Approval to write off the balance owing on an account so that it can be terminated.",
  reasonCodes: [
    { code: "UNCOLLECTABLE", label: "Uncollectable" },
    { code: "ABSCONDED", label: "Customer absconded" },
    { code: "DISPUTED_SETTLED", label: "Dispute settled" },
    { code: "DECEASED", label: "Customer deceased" },
    { code: "OTHER", label: "Other (explain in the note)" },
  ],
  policy: { levels: [{ label: "Accountant", permission: "billing:adjust" }], slaHours: 48 },
});

/**
 * Records the decision on the account's command log (`write_off_decided`, which changes no
 * status). The command's id is the request's, so a second delivery writes nothing.
 */
export const recordWriteOffDecision = defineApprovalConsumer(writeOffApproval, "accounts.record_write_off_decision", async (ctx, decided) => {
  const { tx, organizationId } = ctx;
  const [row] = await tx.select().from(account).where(eq(account.id, decided.subjectRef));
  if (!row) throw new Error(`Write-off ${decided.requestId} names an account that does not exist: ${decided.subjectRef}`);
  const [inserted] = await tx
    .insert(accountCommand)
    .values({
      id: decided.requestId,
      organizationId,
      accountId: row.id,
      kind: "write_off_decided",
      fromCommercialStatus: row.commercialStatus,
      toCommercialStatus: row.commercialStatus,
      fromServiceStatus: row.serviceStatus,
      toServiceStatus: row.serviceStatus,
      serviceReason: row.serviceStatusReason,
      reason: `Write-off ${decided.outcome}`,
      actorUserId: null,
      source: "system",
      payload: { approvalId: decided.requestId, outcome: decided.outcome, amount: decided.amount },
    })
    .onConflictDoNothing()
    .returning({ id: accountCommand.id });
  if (!inserted) return;
  await systemEnv(tx, organizationId).audit({
    action: "accounts.write_off_decided",
    subjectType: "account",
    subjectId: row.id,
    after: { approvalId: decided.requestId, outcome: decided.outcome, amount: decided.amount },
    reason: `Write-off ${decided.outcome}`,
  });
});
