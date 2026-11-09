import { approvalPolicySetting } from "./approval-store";
import { approvals } from "./approval-registry";
import type { SettingDef } from "./config-store";
import { activationSetting, numberingSetting, statusRulesSetting } from "../modules/accounts";
import { tariffPolicySetting } from "../modules/tariffs";
import { kindPolicySetting } from "../modules/work-orders";
import { regionalSetting } from "./regional";

/**
 * Every setting in the configuration store (K-10). A module adds its own when it ships
 * (billing policy, estimation policy, statuses, templates), defined in its module folder.
 * Each approval kind brings its policy (`approvals.<kind>`).
 */
export const settings: readonly SettingDef[] = [
  regionalSetting as SettingDef,
  kindPolicySetting as SettingDef,
  numberingSetting as SettingDef,
  statusRulesSetting as SettingDef,
  activationSetting as SettingDef,
  tariffPolicySetting as SettingDef,
  ...approvals.map((a) => approvalPolicySetting(a) as SettingDef),
];
