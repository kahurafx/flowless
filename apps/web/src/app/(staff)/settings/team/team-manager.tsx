"use client";

import {
  DEFAULT_ROLES,
  PERMISSION_STATEMENTS,
  type Permission,
  type PermissionResource,
} from "@flowless/shared-types";
import { ChevronRightIcon } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { TeamMember } from "@/data/team";
import { permissionLabel, resourceLabel, roleLabel } from "@/lib/permission-labels";
import { setPermission } from "./actions";

const RESOURCES = Object.keys(PERMISSION_STATEMENTS) as PermissionResource[];
const permissionsOf = (resource: PermissionResource) =>
  PERMISSION_STATEMENTS[resource].map((action) => `${resource}:${action}` as Permission);

const fromRoles = (member: TeamMember) => new Set<Permission>(member.roles.flatMap((r) => DEFAULT_ROLES[r]));

export function TeamManager({
  members,
  myPermissions,
}: {
  members: TeamMember[];
  myPermissions: readonly Permission[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Keep the last member while the sheet animates out, so it leaves the way it came.
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = members.find((m) => m.userId === shownId) ?? null;

  return (
    <>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {members.map((m) => {
          const all = fromRoles(m).size;
          return (
            <li key={m.userId}>
              <button
                type="button"
                onClick={() => {
                  setShownId(m.userId);
                  setOpenId(m.userId);
                }}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-[background-color,scale] duration-100 ease-out hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:scale-[0.99] pointer-coarse:min-h-14"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{m.signIn}</span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {m.roles.map((r) => (
                    <Badge key={r} variant="secondary">
                      {roleLabel[r]}
                    </Badge>
                  ))}
                  {m.grants.length > 0 && <Badge variant="info">+{m.grants.length} extra</Badge>}
                </span>
                <span className="tabular hidden w-28 shrink-0 text-right text-xs text-muted-foreground sm:block">
                  {all + m.grants.filter((g) => !fromRoles(m).has(g)).length} permissions
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>

      <Sheet open={openId !== null} onOpenChange={(open) => !open && setOpenId(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          {shown && <MemberPermissions key={shown.userId} member={shown} myPermissions={myPermissions} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function MemberPermissions({ member, myPermissions }: { member: TeamMember; myPermissions: readonly Permission[] }) {
  const roleDefaults = fromRoles(member);
  const [grants, setOptimisticGrants] = useOptimistic(
    new Set(member.grants),
    (current: Set<Permission>, change: { permission: Permission; granted: boolean }) => {
      const next = new Set(current);
      if (change.granted) next.add(change.permission);
      else next.delete(change.permission);
      return next;
    },
  );
  const [, startTransition] = useTransition();

  const toggle = (permission: Permission, granted: boolean) =>
    startTransition(async () => {
      setOptimisticGrants({ permission, granted });
      const { error } = await setPermission(member.userId, permission, granted);
      if (error) toast.error(error);
    });

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>{member.name}</SheetTitle>
        <SheetDescription>
          {member.roles.map((r) => roleLabel[r]).join(", ") || "No role"}. Ticked and locked permissions come with the
          role; tick others to grant them to {member.name.split(" ")[0]} only.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        {RESOURCES.map((resource) => (
          <fieldset key={resource} className="border-b py-3 last:border-b-0">
            <legend className="label-caps pt-3 text-muted-foreground">{resourceLabel[resource]}</legend>
            <div className="mt-2 flex flex-col">
              {permissionsOf(resource).map((p) => {
                const inRole = roleDefaults.has(p);
                const canGrant = myPermissions.includes(p);
                const id = `perm-${p}`;
                return (
                  <label
                    key={p}
                    htmlFor={id}
                    className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-1 text-sm has-disabled:cursor-default pointer-coarse:min-h-11"
                  >
                    <Checkbox
                      id={id}
                      checked={inRole || grants.has(p)}
                      disabled={inRole || !canGrant}
                      onCheckedChange={(checked) => toggle(p, checked)}
                    />
                    <span className="flex-1">{permissionLabel[p]}</span>
                    {inRole ? (
                      <span className="text-xs text-muted-foreground">From role</span>
                    ) : grants.has(p) ? (
                      <Badge variant="info">Extra</Badge>
                    ) : !canGrant ? (
                      <span className="text-xs text-muted-foreground">You don&apos;t hold this</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </>
  );
}
