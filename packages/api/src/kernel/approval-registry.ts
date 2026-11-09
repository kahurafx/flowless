import { writeOffApproval } from "../modules/accounts";
import type { ApprovalDef } from "./approval-store";

/**
 * Every approval kind (K-05). A module adds its own when it ships (a rebate, a receipt
 * cancellation, a write-off), defined in its module folder, with a consumer of
 * `approval.decided` (`defineApprovalConsumer`) in `kernel/consumers.ts` to apply outcomes.
 */
export const approvals: readonly ApprovalDef[] = [writeOffApproval];
