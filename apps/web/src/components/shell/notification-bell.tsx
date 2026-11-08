"use client";

import { BellIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Inbox } from "@/data/notifications";
import { loadInbox, markAllRead } from "./notification-actions";

const POLL_MS = 60_000;

/** In-app notifications (K-07). Refreshes once a minute and when opened; opening marks them read. */
export function NotificationBell({ initial, locale, timeZone }: { initial: Inbox; locale: string; timeZone: string }) {
  const [inbox, setInbox] = useState(initial);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadInbox().then(setInbox, () => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    loadInbox().then(setInbox, () => {});
    if (inbox.unread > 0) {
      markAllRead().then(
        () => setInbox((current) => ({ ...current, unread: 0 })),
        () => {},
      );
    }
  };

  const label = inbox.unread ? `Notifications, ${inbox.unread} unread` : "Notifications";
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={label} className="relative" />}>
        <BellIcon />
        {inbox.unread > 0 && (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
            {inbox.unread > 9 ? "9+" : inbox.unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        {inbox.items.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {inbox.items.map((n) => (
              <DropdownMenuItem
                key={n.id}
                render={n.link ? <Link href={n.link} /> : undefined}
                className="flex flex-col items-start gap-0.5 py-2"
              >
                <span className="flex w-full items-center gap-2">
                  {!n.readAt && <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" />}
                  <span className="truncate font-medium">{n.title}</span>
                </span>
                {n.body && <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>}
                <span className="text-xs text-muted-foreground">{when.format(n.createdAt)}</span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
