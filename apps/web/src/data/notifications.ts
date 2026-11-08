import { getApi } from "./session";

/** The signed-in member's in-app notifications (K-07), newest first, and how many are unread. */
export async function getInbox() {
  const { api } = await getApi();
  const [items, unread] = await Promise.all([api.notifications.list({ limit: 20 }), api.notifications.unreadCount()]);
  return { items, unread };
}

export type Inbox = Awaited<ReturnType<typeof getInbox>>;
