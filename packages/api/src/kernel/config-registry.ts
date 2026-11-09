import type { SettingDef } from "./config-store";
import { regionalSetting } from "./regional";

/**
 * Every setting in the configuration store (K-10). A module adds its own from its
 * `registerKernel` (called in `src/wiring.ts`) with `registerSetting`, defined in its module
 * folder; settings come in registration order, then each approval kind's policy
 * (`approvals.<kind>`, added by `registerApproval`). Live: read it only after wiring.
 */
export const settings: readonly SettingDef[] = [regionalSetting as SettingDef];

const list = settings as SettingDef[];
const keys = new Set<string>(list.map((s) => s.key));
let own = list.length;

function add(def: SettingDef, at: number): void {
  if (keys.has(def.key)) throw new Error(`Setting "${def.key}" is registered twice`);
  keys.add(def.key);
  list.splice(at, 0, def);
}

export function registerSetting<T>(def: SettingDef<T>): void {
  add(def as SettingDef, own++);
}

/** An approval kind's policy setting, kept after the module settings. Called by `registerApproval`. */
export function registerApprovalSetting(def: SettingDef): void {
  add(def, list.length);
}
