import { z } from "zod";
import { isPermission, type Permission } from "./permissions";

const permission = z.string().refine(isPermission, "Unknown permission") as unknown as z.ZodType<Permission>;
const reasonCode = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,32}$/, "Reason codes are 2–32 capital letters, digits or _"),
  label: z.string().trim().min(1).max(80),
});

/**
 * An organization's policy for one approval kind (K-05), kept in the configuration store
 * (K-10). Levels decide in order; a level with `minAmount` (minor units, as digits) only
 * applies to requests of at least that amount, so small requests skip it, and a request no
 * level applies to is approved at once. Past `slaHours` at a level, the request is
 * escalated: it shows in the exception queue and holders of `escalateTo` may decide it too.
 * The API registers it per kind; the web edits it with the same type.
 */
export const approvalPolicySchema = z.object({
  levels: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        permission,
        minAmount: z.string().regex(/^\d+$/, "Amounts are whole minor units").optional(),
      }),
    )
    .max(5),
  slaHours: z.number().int().min(1).max(720).default(48),
  escalateTo: permission.optional(),
  /** Replaces the kind's default reason codes when set. */
  reasonCodes: z.array(reasonCode).max(50).optional(),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
