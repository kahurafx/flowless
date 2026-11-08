import { JUNCTION_TYPES } from "@flowless/shared-types";
import { z } from "zod";

const SizeMm = z.number().int().positive().max(5000);

/** A junction's fittings (ported from Majimap's shared JunctionSchema). `branchSizeMm: null` means the same size all through. */
export const JunctionSchema = z
  .object({ type: z.enum(JUNCTION_TYPES), mainSizeMm: SizeMm, branchSizeMm: SizeMm.nullable() })
  .refine((j) => j.branchSizeMm === null || j.branchSizeMm < j.mainSizeMm, {
    message: "The smaller size must be less than the main size",
    path: ["branchSizeMm"],
  })
  .refine((j) => j.type !== "reducer" || j.branchSizeMm !== null, {
    message: "A reducer must step down to a smaller size",
    path: ["branchSizeMm"],
  });
export type JunctionSpec = z.infer<typeof JunctionSchema>;

export type JunctionColumns = { junctionType: JunctionSpec["type"] | null; mainSizeMm: number | null; branchSizeMm: number | null };

/** The three columns for a junction spec, or all NULL for none. */
export const junctionColumns = (j: JunctionSpec | null | undefined): JunctionColumns => ({
  junctionType: j?.type ?? null,
  mainSizeMm: j?.mainSizeMm ?? null,
  branchSizeMm: j?.branchSizeMm ?? null,
});

/** The spec a row holds, or null when the details haven't been recorded. */
export function junctionFromRow(row: Partial<JunctionColumns>): JunctionSpec | null {
  return row.junctionType && row.mainSizeMm ? { type: row.junctionType, mainSizeMm: row.mainSizeMm, branchSizeMm: row.branchSizeMm ?? null } : null;
}
