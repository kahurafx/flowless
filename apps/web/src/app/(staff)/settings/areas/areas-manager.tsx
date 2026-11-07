"use client";

import { AREA_LEVELS, areaLevelLabel, areaParentProblem, type Area, type AreaLevel, type Route } from "@flowless/shared-types";
import { PlusIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { flattenTree } from "@/lib/tree";
import { createArea, createRoute, setArchived } from "./actions";

const NONE = "none";
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, undefined, { numeric: true });

export function AreasManager({ areas, routes, canManage }: { areas: Area[]; routes: Route[]; canManage: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const visible = <T extends { archivedAt: Date | null }>(rows: T[]) => (showArchived ? rows : rows.filter((r) => !r.archivedAt));
  const archivedCount = areas.filter((a) => a.archivedAt).length + routes.filter((r) => r.archivedAt).length;

  return (
    <div className="flex flex-col gap-4">
      {archivedCount > 0 && (
        <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={showArchived} onCheckedChange={setShowArchived} />
          Show archived ({archivedCount})
        </label>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <TreeSection
          title="Areas"
          empty="No areas yet. Start with a scheme."
          action={canManage && <AddAreaDialog areas={areas.filter((a) => !a.archivedAt)} />}
          rows={flattenTree(visible(areas), (a, b) => AREA_LEVELS.indexOf(a.level) - AREA_LEVELS.indexOf(b.level) || byCode(a, b))}
          kind="area"
          canManage={canManage}
          eyebrow={(a) => areaLevelLabel[a.level]}
        />
        <TreeSection
          title="Routes"
          empty="No routes yet."
          action={canManage && <AddRouteDialog areas={areas.filter((a) => !a.archivedAt)} routes={routes.filter((r) => !r.archivedAt)} />}
          rows={flattenTree(visible(routes), byCode)}
          kind="route"
          canManage={canManage}
          eyebrow={(r) => (routes.some((child) => child.parentId === r.id) ? "Group" : "Route")}
        />
      </div>
    </div>
  );
}

function TreeSection<T extends { id: string; code: string; name: string; archivedAt: Date | null }>({
  title,
  empty,
  action,
  rows,
  kind,
  canManage,
  eyebrow,
}: {
  title: string;
  empty: string;
  action: React.ReactNode;
  rows: { item: T; depth: number }[];
  kind: "area" | "route";
  canManage: boolean;
  eyebrow: (item: T) => string;
}) {
  const headingId = useId();
  const [pending, startTransition] = useTransition();
  const toggle = (item: T) =>
    startTransition(async () => {
      const { error } = await setArchived(kind, item.id, !item.archivedAt);
      if (error) toast.error(error);
    });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="font-semibold">
          {title}
        </h2>
        <span className="tabular text-sm text-muted-foreground">{rows.length}</span>
        <div className="ml-auto">{action}</div>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-busy={pending}>
          {rows.map(({ item, depth }) => (
            <li
              key={item.id}
              className="group flex min-h-12 items-center gap-3 py-2 pr-2 text-sm"
              style={{ paddingLeft: `calc(1rem + ${depth} * 1.25rem)` }}
            >
              <span className={`flex min-w-0 flex-1 flex-col ${item.archivedAt ? "opacity-60" : ""}`}>
                <span className="label-caps text-muted-foreground">{eyebrow(item)}</span>
                <span className="truncate font-medium">{item.name}</span>
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.code}</span>
              {item.archivedAt && <Badge variant="outline">Archived</Badge>}
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => toggle(item)}
                  className="opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 pointer-coarse:opacity-100"
                >
                  {item.archivedAt ? "Restore" : "Archive"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function useSubmit(close: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (save: () => Promise<{ error: string | null }>) =>
    startTransition(async () => {
      const result = await save();
      setError(result.error);
      if (!result.error) close();
    });
  return { error, pending, submit, reset: () => setError(null) };
}

function AddAreaDialog({ areas }: { areas: Area[] }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<AreaLevel>(areas.length ? "zone" : "scheme");
  const [parentId, setParentId] = useState(NONE);
  const { error, pending, submit, reset } = useSubmit(() => setOpen(false));
  const parents = areas.filter((a) => areaParentProblem(level, a.level) === null).sort(byCode);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add area
      </Button>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            submit(() =>
              createArea({
                level,
                code: String(form.get("code")),
                name: String(form.get("name")),
                parentId: level === "scheme" || parentId === NONE ? null : parentId,
              }),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Add area</DialogTitle>
            <DialogDescription>Each area sits under a higher level. Skip levels you don&apos;t use.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="area-level">Level</Label>
            <Select
              value={level}
              onValueChange={(v) => {
                setLevel(v as AreaLevel);
                setParentId(NONE);
              }}
            >
              <SelectTrigger id="area-level" className="w-full">
                <SelectValue>{(v: AreaLevel) => areaLevelLabel[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AREA_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {areaLevelLabel[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {level !== "scheme" && (
            <div className="grid gap-2">
              <Label htmlFor="area-parent">Inside</Label>
              <Select value={parentId} onValueChange={(v) => setParentId(String(v))}>
                <SelectTrigger id="area-parent" className="w-full">
                  <SelectValue>
                    {(v: string) => {
                      const p = areas.find((a) => a.id === v);
                      return p ? `${p.name} · ${areaLevelLabel[p.level]}` : "Choose a parent";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {parents.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {areaLevelLabel[p.level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <CodeAndName codePlaceholder={level === "dma" ? "DMA-04" : "KW"} />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || (level !== "scheme" && parentId === NONE)}>
              Add {areaLevelLabel[level].toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddRouteDialog({ areas, routes }: { areas: Area[]; routes: Route[] }) {
  const [open, setOpen] = useState(false);
  const [parentId, setParentId] = useState(NONE);
  const [areaId, setAreaId] = useState(NONE);
  const { error, pending, submit, reset } = useSubmit(() => setOpen(false));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        reset();
      }}
    >
      <Button size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add route
      </Button>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            submit(() =>
              createRoute({
                code: String(form.get("code")),
                name: String(form.get("name")),
                parentId: parentId === NONE ? null : parentId,
                areaId: areaId === NONE ? null : areaId,
              }),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Add route</DialogTitle>
            <DialogDescription>Routes group service points for reading and field work. A route can belong to a group.</DialogDescription>
          </DialogHeader>
          <OptionalSelect
            id="route-parent"
            label="Route group"
            value={parentId}
            onChange={setParentId}
            options={[...routes].sort(byCode).map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }))}
          />
          <OptionalSelect
            id="route-area"
            label="Mostly serves"
            value={areaId}
            onChange={setAreaId}
            options={[...areas].sort(byCode).map((a) => ({ value: a.id, label: `${a.name} · ${areaLevelLabel[a.level]}` }))}
          />
          <CodeAndName codePlaceholder="R-07" />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Add route
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionalSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(String(v))}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{(v: string) => options.find((o) => o.value === v)?.label ?? "None"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CodeAndName({ codePlaceholder }: { codePlaceholder: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <div className="grid gap-2">
        <Label htmlFor="code">Code</Label>
        <Input id="code" name="code" required maxLength={32} placeholder={codePlaceholder} className="font-mono" autoComplete="off" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required maxLength={120} autoComplete="off" />
      </div>
    </div>
  );
}
