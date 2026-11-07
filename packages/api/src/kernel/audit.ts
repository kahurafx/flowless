import { auditLog } from "@flowless/db";
import { and, desc, eq, like, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { permittedProcedure, router } from "../trpc";

/** The audit log (K-06), newest first. Reading it needs `audit:read`. */
export const auditRouter = router({
  list: permittedProcedure("audit:read")
    .input(
      z
        .object({
          subjectType: z.string().max(40).optional(),
          subjectId: z.string().max(80).optional(),
          actorUserId: z.uuid().optional(),
          /** e.g. "access." for every access change. */
          actionPrefix: z.string().max(40).optional(),
          /** Entries older than this chain index, for paging. */
          before: z.bigint().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.tx
        .select({
          id: auditLog.id,
          index: auditLog.chainIndex,
          occurredAt: auditLog.occurredAt,
          actorUserId: auditLog.actorUserId,
          actorLabel: auditLog.actorLabel,
          source: auditLog.source,
          action: auditLog.action,
          subjectType: auditLog.subjectType,
          subjectId: auditLog.subjectId,
          before: auditLog.before,
          after: auditLog.after,
          reason: auditLog.reason,
          ipAddress: auditLog.ipAddress,
        })
        .from(auditLog)
        .where(
          and(
            input.subjectType ? eq(auditLog.subjectType, input.subjectType) : undefined,
            input.subjectId ? eq(auditLog.subjectId, input.subjectId) : undefined,
            input.actorUserId ? eq(auditLog.actorUserId, input.actorUserId) : undefined,
            input.actionPrefix ? like(auditLog.action, `${input.actionPrefix.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
            input.before ? lt(auditLog.chainIndex, input.before) : undefined,
          ),
        )
        .orderBy(desc(auditLog.chainIndex))
        .limit(input.limit + 1);
      const more = rows.length > input.limit;
      const entries = more ? rows.slice(0, input.limit) : rows;
      return { entries, next: more ? entries.at(-1)!.index : null };
    }),

  /** Re-checks this organization's hash chain (NF-07). `firstBroken` is null when intact. */
  verify: permittedProcedure("audit:read").query(async ({ ctx }) => {
    const [row] = await ctx.tx.execute<{ checked: string; first_broken: string | null }>(
      sql`select * from kernel.verify_audit_chain()`,
    );
    return { checked: BigInt(row!.checked), firstBroken: row!.first_broken === null ? null : BigInt(row!.first_broken) };
  }),
});
