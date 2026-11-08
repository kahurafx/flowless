"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Entitlements, Permission } from "@flowless/shared-types";
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
import { currentHref, navFor } from "./nav";
import { OrganizationBadge } from "./organization-badge";
import { UserMenu } from "./user-menu";

export function AppSidebar({
  entitlements,
  permissions,
  organization,
  user,
}: {
  entitlements: Entitlements;
  permissions: readonly Permission[];
  organization: { name: string; code: string };
  user: { name: string; email: string };
}) {
  const pathname = usePathname();
  const items = navFor(entitlements, permissions);
  const current = currentHref(pathname, items);
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrganizationBadge organization={organization} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={item.href === current}
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
        <UserMenu user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
