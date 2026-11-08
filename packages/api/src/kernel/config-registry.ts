import type { SettingDef } from "./config-store";
import { regionalSetting } from "./regional";

/**
 * Every setting in the configuration store (K-10). A module adds its own when it ships
 * (billing policy, estimation policy, statuses, templates), defined in its module folder.
 */
export const settings: readonly SettingDef[] = [regionalSetting as SettingDef];
