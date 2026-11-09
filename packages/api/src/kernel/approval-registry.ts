import { approvalPolicySetting, type ApprovalDef } from "./approval-store";
import { registerApprovalSetting } from "./config-registry";
import type { SettingDef } from "./config-store";

/**
 * Every approval kind (K-05). A module adds its own (a rebate, a receipt cancellation, a
 * write-off) from its `registerKernel` (called in `src/wiring.ts`) with `registerApproval`,
 * defined in its module folder, with a consumer of `approval.decided`
 * (`defineApprovalConsumer`) registered the same way to apply outcomes. Registering a kind
 * also adds its policy setting `approvals.<key>` to the config registry. Live: read it only
 * after wiring.
 */
export const approvals: readonly ApprovalDef[] = [];

const list = approvals as ApprovalDef[];

export function registerApproval(def: ApprovalDef): void {
  if (list.some((a) => a.key === def.key)) throw new Error(`Approval "${def.key}" is registered twice`);
  list.push(def);
  registerApprovalSetting(approvalPolicySetting(def) as SettingDef);
}
