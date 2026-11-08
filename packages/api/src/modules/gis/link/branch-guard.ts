import { PERSONAL_BRANCH_PREFIX, personalBranch, type Permission } from "@flowless/shared-types";
import type { BranchGuard, BranchVerdict } from "../../../kernel/work";

/** Majimap's unguarded personal branches ("field-<username>"): reserved and refused in Flowless. */
export const LEGACY_FIELD_PREFIX = "field-";

/**
 * Who may write to a personal branch `fld-<userId>` (a W3 gap fix: Majimap's `field-*`
 * branches let anyone write). Its owner; and members who may post to main (`gis:post`), so
 * an engineer can tidy it before posting. Pure.
 */
export function decidePersonalBranchWrite(branch: string, who: { userId: string; permissions: ReadonlySet<Permission> }): BranchVerdict {
  if (branch.toLowerCase() === personalBranch(who.userId)) return { allowed: true };
  if (who.permissions.has("gis:post")) return { allowed: true };
  return { allowed: false, reason: "That is someone else's field branch: use your own (fld-<your id>) or a job's branch" };
}

export const personalBranchGuard: BranchGuard = {
  prefix: PERSONAL_BRANCH_PREFIX,
  async check(_tx, write) {
    return decidePersonalBranchWrite(write.branch, write);
  },
};
