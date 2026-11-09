import { Suspense } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandPalette } from "@/components/shell/command-palette";
import { NotificationBell } from "@/components/shell/notification-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getInbox } from "@/data/notifications";
import { getSession } from "@/data/session";

export default function StaffLayout({ children }: LayoutProps<"/">) {
  return (
    <TooltipProvider>
      {/* The session is request-time (cookies), so the shell streams behind a skeleton. */}
      <Suspense fallback={<ShellSkeleton />}>
        <Shell>{children}</Shell>
      </Suspense>
      <Toaster />
    </TooltipProvider>
  );
}

async function Shell({ children }: { children: React.ReactNode }) {
  const { organization, user, access } = await getSession();
  const inbox = await getInbox();
  return (
    <SidebarProvider>
      <AppSidebar
        entitlements={organization.entitlements}
        permissions={access.permissions}
        organization={organization}
        user={user}
      />
      <SidebarInset className="min-w-0">
        {/* Translucent bar; content scrolls under it (apple-design §12). */}
        <header className="material-bar sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarTrigger />
          <CommandPalette
            entitlements={organization.entitlements}
            permissions={access.permissions}
          />
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell initial={inbox} locale={organization.settings.locale} timeZone={organization.settings.timeZone} />
            <ThemeToggle />
          </div>
        </header>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-svh">
      <div className="hidden w-64 border-r bg-sidebar p-3 md:block">
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="flex-1 p-6">
        <Skeleton className="h-8 w-48" />
      </div>
    </div>
  );
}
