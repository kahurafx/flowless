import { enqueueEvent, notification, type Transaction } from "@flowless/db";
import type { NotificationChannel } from "@flowless/shared-types";
import { z } from "zod";
import { loadEntitlements } from "./entitlement-store";
import { defineEvent } from "./events";
import { isForeignKeyViolation } from "./pg-errors";

const EXTERNAL = ["sms", "email", "push", "whatsapp"] as const;

/**
 * A message for the Communications module to deliver (K-07): it renders `template` in the
 * organization's language, sends through its provider and charges the wallet. Published
 * only while Communications is licensed.
 */
export const notificationRequested = defineEvent(
  "notification.requested",
  z.object({
    channel: z.enum(EXTERNAL),
    to: z.object({ userId: z.uuid().optional(), phone: z.string().optional(), email: z.string().optional() }),
    template: z.string(),
    topic: z.string(),
    data: z.record(z.string(), z.unknown()),
    dedupeKey: z.string().nullable(),
  }),
);

export interface Notify {
  to: { userId?: string; phone?: string; email?: string };
  /** Default in-app only. */
  channels?: readonly NotificationChannel[];
  /** "<area>.<event>", e.g. "exceptions.assigned". */
  topic: string;
  /** In-app text. External channels use `template` (default the topic) with `data`. */
  title: string;
  body?: string;
  /** App path the in-app notification opens. */
  link?: string;
  template?: string;
  data?: Record<string, unknown>;
  /** Notifying again with the same key does nothing. */
  dedupeKey?: string;
}

export interface NotifyResult {
  sent: NotificationChannel[];
  /** Channels that could not be used: no such recipient for it, or Communications is not licensed. */
  skipped: NotificationChannel[];
}

/**
 * The notification interface (K-07), inside the caller's transaction. In-app goes to the
 * member's inbox (a recipient who is not a member is skipped, not an error); the other
 * channels are handed to the Communications module through the outbox. Never throws for
 * a channel it cannot use: it says so in `skipped`, so the caller decides.
 */
export async function notify(tx: Transaction, organizationId: string, input: Notify): Promise<NotifyResult> {
  const result: NotifyResult = { sent: [], skipped: [] };
  let communications: boolean | undefined;

  for (const channel of input.channels ?? ["in_app"]) {
    if (channel === "in_app") {
      const recipient = input.to.userId;
      const inserted = recipient
        ? await tx
            .transaction((sp) =>
              sp
                .insert(notification)
                .values({
                  organizationId,
                  recipientUserId: recipient,
                  topic: input.topic,
                  title: input.title,
                  body: input.body ?? "",
                  link: input.link ?? null,
                  dedupeKey: input.dedupeKey ?? null,
                })
                .onConflictDoNothing()
                .returning({ id: notification.id }),
            )
            .catch((error: unknown) => {
              if (isForeignKeyViolation(error)) return null;
              throw error;
            })
        : null;
      (inserted ? result.sent : result.skipped).push(channel);
      continue;
    }

    communications ??= (await loadEntitlements(tx)).includes("communications");
    const reachable = channel === "sms" || channel === "whatsapp" ? input.to.phone || input.to.userId : channel === "email" ? input.to.email || input.to.userId : input.to.userId;
    if (!communications || !reachable) {
      result.skipped.push(channel);
      continue;
    }
    await enqueueEvent(tx, {
      organizationId,
      type: notificationRequested.type,
      version: notificationRequested.version,
      payload: notificationRequested.schema.parse({
        channel,
        to: input.to,
        template: input.template ?? input.topic,
        topic: input.topic,
        data: input.data ?? {},
        dedupeKey: input.dedupeKey ?? null,
      }),
    });
    result.sent.push(channel);
  }
  return result;
}
