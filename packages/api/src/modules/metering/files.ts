import { reading } from "@flowless/db/schema/metering";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { defineFileSubject } from "../../kernel/file-subjects";
import { accountVisibleTo } from "../accounts";

/**
 * Photos on a reading (M-04, K-08). A reading is found only while the reader may see its
 * account; adding a photo needs `readings:capture` and being the reader (or an approver);
 * removing evidence is an approver's call. A device uploads photos after the reading syncs.
 */
export const readingFileSubject = defineFileSubject({
  kind: "reading",
  module: "metering",
  label: "Meter reading",
  async authorize(ctx, subjectId, mode) {
    const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Reading not found" });
    if (!ctx.permissions.has("readings:read") || !/^[0-9a-f-]{36}$/i.test(subjectId)) throw notFound();
    const [row] = await ctx.tx.select().from(reading).where(eq(reading.id, subjectId));
    if (!row) throw notFound();
    if (row.accountId && !(await accountVisibleTo(ctx.tx, { userId: ctx.userId, scope: await ctx.scope() }, row.accountId))) throw notFound();
    const approver = ctx.permissions.has("readings:approve");
    if (mode === "read") return { manage: approver };
    if (!ctx.permissions.has("readings:capture") && !approver) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot add photos to readings" });
    if (row.readerUserId !== ctx.userId && !approver) throw new TRPCError({ code: "FORBIDDEN", message: "Only the reader or an approver can change a reading's photos" });
    if (mode === "remove" && !approver) throw new TRPCError({ code: "FORBIDDEN", message: "Evidence on a reading can only be removed by an approver" });
    return { manage: approver };
  },
});
