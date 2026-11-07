"use client";

import { CheckIcon, ChevronsUpDownIcon, DropletsIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

export function OrgSwitcher({
  active,
  memberships,
}: {
  active: { id: string; name: string };
  memberships: readonly { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Better Auth checks membership and stores the choice on the session. Records from the
  // old tenant mean nothing in the new one, so land on the overview.
  const switchTo = (organizationId: string) =>
    startTransition(async () => {
      const { error } = await authClient.organization.setActive({ organizationId });
      if (error) return;
      router.push("/");
      router.refresh();
    });
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" aria-busy={pending} className="data-popup-open:bg-sidebar-accent" />}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <DropletsIcon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col text-left leading-tight">
              <span className="label-caps text-muted-foreground">Flowless</span>
              <span className={pending ? "truncate font-medium opacity-60" : "truncate font-medium"}>{active.name}</span>
            </span>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {memberships.map((org) => (
                <DropdownMenuItem
                  key={org.id}
                  onClick={() => org.id !== active.id && switchTo(org.id)}
                >
                  <span className="truncate">{org.name}</span>
                  {org.id === active.id && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
