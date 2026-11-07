"use client";

import {
  AREA_LEVELS,
  areaLevelLabel,
  DEFAULT_ROLES,
  PERMISSION_STATEMENTS,
  type Permission,
  type PermissionResource,
} from "@flowless/shared-types";
import { ChevronRightIcon } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { TeamData, TeamMember } from "@/data/team";
import { flattenTree } from "@/lib/tree";
import { permissionLabel, resourceLabel, roleLabel } from "@/lib/permission-labels";
import { setPermission, setScope } from "./actions";

const RESOURCES = Object.keys(PERMISSION_STATEMENTS) as PermissionResource[];
const permissionsOf = (resource: PermissionResource) =>
  PERMISSION_STATEMENTS[resource].map((action) => `${resource}:${action}` as Permission);

const fromRoles = (member: TeamMember) => new Set<Permission>(member.roles.flatMap((r) => DEFAULT_ROLES[r]));

type Hierarchy = Pick<TeamData, "areas" | "routes" | "myScope">;

export function TeamManager({ members, myPermissions, myScope, areas, routes }: TeamData) {
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
                  {m.scope.areaIds.length + m.scope.routeIds.length > 0 && <Badge variant="outline">Limited</Badge>}
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
          {shown && (
            <MemberPermissions
              key={shown.userId}
              member={shown}
              myPermissions={myPermissions}
              hierarchy={{ areas, routes, myScope }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function MemberPermissions({
  member,
  myPermissions,
  hierarchy,
}: {
  member: TeamMember;
  myPermissions: readonly Permission[];
  hierarchy: Hierarchy;
}) {
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
        <Coverage member={member} hierarchy={hierarchy} />
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

/** Everything at or below each of `roots` in a parent-linked list. */
function covered(items: readonly { id: string; parentId: string | null }[], roots: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id)) return;
    result.add(id);
    for (const child of items) if (child.parentId === id) visit(child.id);
  };
  for (const id of roots) visit(id);
  return result;
}

/** Scope restrictions (K-03): the whole organization, or only some areas and routes. */
function Coverage({ member, hierarchy }: { member: TeamMember; hierarchy: Hierarchy }) {
  const { myScope } = hierarchy;
  const initiallyLimited = member.scope.areaIds.length + member.scope.routeIds.length > 0;
  const [limited, setLimited] = useState(initiallyLimited || myScope.kind === "limited");
  const [areaIds, setAreaIds] = useState(() => new Set(member.scope.areaIds));
  const [routeIds, setRouteIds] = useState(() => new Set(member.scope.routeIds));
  const [pending, startTransition] = useTransition();

  // A manager who is limited can only hand out what they cover.
  const mayGive = (kind: "area" | "route", id: string) =>
    myScope.kind === "all" || (kind === "area" ? myScope.areaIds : myScope.routeIds).includes(id);
  const areas = hierarchy.areas.filter((a) => mayGive("area", a.id));
  const routes = hierarchy.routes.filter((r) => mayGive("route", r.id));
  const areaRows = flattenTree(areas, (a, b) => AREA_LEVELS.indexOf(a.level) - AREA_LEVELS.indexOf(b.level) || a.code.localeCompare(b.code));
  const routeRows = flattenTree(routes, (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const areasCovered = covered(areas, areaIds);
  const routesCovered = covered(routes, routeIds);

  const changed =
    limited !== initiallyLimited ||
    (limited &&
      (areaIds.size !== member.scope.areaIds.length ||
        routeIds.size !== member.scope.routeIds.length ||
        member.scope.areaIds.some((id) => !areaIds.has(id)) ||
        member.scope.routeIds.some((id) => !routeIds.has(id))));
  const empty = limited && areaIds.size + routeIds.size === 0;

  const save = () =>
    startTransition(async () => {
      const { error } = await setScope(member.userId, limited ? [...areaIds] : [], limited ? [...routeIds] : []);
      if (error) toast.error(error);
      else toast.success(limited ? "Coverage limited" : "Covers the whole organization");
    });

  const toggle = (set: Set<string>, update: (next: Set<string>) => void, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    update(next);
  };

  return (
    <fieldset className="border-b py-3">
      <legend className="label-caps pt-3 text-muted-foreground">Coverage</legend>
      <div className="mt-2 flex flex-col gap-1 text-sm">
        <label className="flex min-h-10 items-center gap-3 px-1 has-disabled:opacity-50">
          <input
            type="radio"
            name={`coverage-${member.userId}`}
            className="size-4 accent-primary"
            checked={!limited}
            disabled={myScope.kind === "limited"}
            onChange={() => setLimited(false)}
          />
          Whole organization
        </label>
        <label className="flex min-h-10 items-center gap-3 px-1">
          <input
            type="radio"
            name={`coverage-${member.userId}`}
            className="size-4 accent-primary"
            checked={limited}
            onChange={() => setLimited(true)}
          />
          Only some areas or routes
        </label>
      </div>
      {limited && (
        <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted/50 p-2">
          <ScopeList
            title="Areas"
            rows={areaRows.map(({ item, depth }) => ({ id: item.id, depth, label: item.name, hint: areaLevelLabel[item.level] }))}
            chosen={areaIds}
            included={areasCovered}
            onToggle={(id, on) => toggle(areaIds, setAreaIds, id, on)}
          />
          <ScopeList
            title="Routes"
            rows={routeRows.map(({ item, depth }) => ({ id: item.id, depth, label: item.name, hint: item.code }))}
            chosen={routeIds}
            included={routesCovered}
            onToggle={(id, on) => toggle(routeIds, setRouteIds, id, on)}
          />
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={!changed || empty || pending}>
          Save coverage
        </Button>
        {empty && <span className="text-xs text-muted-foreground">Choose at least one area or route.</span>}
      </div>
    </fieldset>
  );
}

function ScopeList({
  title,
  rows,
  chosen,
  included,
  onToggle,
}: {
  title: string;
  rows: { id: string; depth: number; label: string; hint: string }[];
  chosen: ReadonlySet<string>;
  included: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{title}</p>
      {rows.map((row) => {
        const viaParent = included.has(row.id) && !chosen.has(row.id);
        const id = `scope-${row.id}`;
        return (
          <label
            key={row.id}
            htmlFor={id}
            className="flex min-h-9 cursor-pointer items-center gap-3 rounded-md pr-1 text-sm has-disabled:cursor-default pointer-coarse:min-h-11"
            style={{ paddingLeft: `calc(0.25rem + ${row.depth} * 1.25rem)` }}
          >
            <Checkbox
              id={id}
              checked={chosen.has(row.id) || viaParent}
              disabled={viaParent}
              onCheckedChange={(on) => onToggle(row.id, on)}
            />
            <span className="flex-1 truncate">{row.label}</span>
            <span className="text-xs text-muted-foreground">{viaParent ? "Included" : row.hint}</span>
          </label>
        );
      })}
    </div>
  );
}
