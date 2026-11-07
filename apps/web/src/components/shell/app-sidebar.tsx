"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Entitlements } from "@flowless/shared-types";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { isActive, navFor } from "./nav";
import { OrgSwitcher } from "./org-switcher";

export function AppSidebar({
  entitlements,
  organization,
  memberships,
  user,
}: {
  entitlements: Entitlements;
  organization: { id: string; name: string };
  memberships: readonly { id: string; name: string }[];
  user: { name: string; role: string };
}) {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher active={organization} memberships={memberships} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navFor(entitlements).map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={isActive(pathname, item.href)}
                    tooltip={item.label}
                    render={<Link href={item.href} />}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex flex-col px-2 py-1.5 text-xs group-data-[collapsible=icon]:hidden">
          <span className="truncate font-medium text-sidebar-foreground">{user.name}</span>
          <span className="truncate text-muted-foreground">{user.role}</span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
