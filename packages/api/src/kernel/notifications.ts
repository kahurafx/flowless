import { notification } from "@flowless/db";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { router, tenantProcedure } from "../trpc";

const mine = (userId: string) => eq(notification.recipientUserId, userId);

/** A member's in-app inbox (K-07). Everyone sees only their own notifications. */
export const notificationsRouter = router({
  list: tenantProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).default({ limit: 30 }))
    .query(({ ctx, input }) =>
      ctx.tx
        .select({
          id: notification.id,
          topic: notification.topic,
          title: notification.title,
          body: notification.body,
          link: notification.link,
          createdAt: notification.createdAt,
          readAt: notification.readAt,
        })
        .from(notification)
        .where(mine(ctx.session.user.id))
        .orderBy(desc(notification.createdAt))
        .limit(input.limit),
    ),

  unreadCount: tenantProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.tx
      .select({ n: count() })
      .from(notification)
      .where(and(mine(ctx.session.user.id), isNull(notification.readAt)));
    return row?.n ?? 0;
  }),

  /** Marks the given notifications read, or all of them without ids. */
  markRead: tenantProcedure
    .input(z.object({ ids: z.array(z.uuid()).max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.tx
        .update(notification)
        .set({ readAt: new Date() })
        .where(and(mine(ctx.session.user.id), isNull(notification.readAt), input.ids ? inArray(notification.id, input.ids) : undefined));
    }),
});
