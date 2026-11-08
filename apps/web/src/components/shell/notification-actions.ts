"use server";

import { getInbox } from "@/data/notifications";
import { getApi } from "@/data/session";

export async function loadInbox() {
  return getInbox();
}

export async function markAllRead() {
  const { api } = await getApi();
  await api.notifications.markRead({});
}
