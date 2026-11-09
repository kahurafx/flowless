"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { linesFromDrafts, linesToDrafts, type LineDraft, type LineView } from "@/lib/invoice-type-form";
import { chargeTypeLabel } from "@/lib/tariff-labels";
import { amountText } from "@/lib/money-input";
import { setInvoiceLinesAction } from "../../actions";

interface CatalogItem {
  code: string;
  name: string;
  type: keyof typeof chargeTypeLabel;
  active: boolean;
  /** The amount in force today as digits of minor units, or null. */
  amount: string | null;
}

/** The typed line template (T-08): charge items by code, in order, with a quantity and an optional amount override. */
export function LinesEditor({ id, lines, catalog, currency, canManage }: { id: string; lines: readonly (LineView & { code: string })[]; catalog: readonly CatalogItem[]; currency: string; locale: string; canManage: boolean }) {
  const initial = linesToDrafts(lines, currency);
  const [drafts, setDrafts] = useState<LineDraft[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = JSON.stringify(drafts) !== JSON.stringify(initial);
  const checked = linesFromDrafts(drafts, currency);
  const byCode = new Map(catalog.map((c) => [c.code, c]));
  // An item already on the template stays choosable even if it has since been deactivated, so it shows by name; a new line offers active items only.
  const optionsFor = (current: string) => catalog.filter((c) => c.active || c.code === current).map((c) => ({ value: c.code, label: `${c.name}${c.active ? "" : " (inactive)"}` }));
  const update = (i: number, patch: Partial<LineDraft>) => setDrafts((d) => d.map((line, j) => (j === i ? { ...line, ...patch } : line)));
  const move = (i: number, by: -1 | 1) =>
    setDrafts((d) => {
      const next = [...d];
      const [line] = next.splice(i, 1);
      next.splice(i + by, 0, line!);
      return next;
    });
  const off = !canManage;

  return (
    <section aria-labelledby="invoice-lines" className="grid gap-4 rounded-xl border bg-card p-4">
      <div>
        <h2 id="invoice-lines" className="font-semibold">
          Line template
        </h2>
        <p className="text-sm text-muted-foreground">The charge items a new invoice of this type carries, in this order. An amount left empty is the catalog amount in force on the day it is invoiced.</p>
      </div>
      {drafts.length === 0 && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No lines: invoices of this type start empty.</p>}
      <ol className="grid gap-3">
        {drafts.map((line, i) => {
          const item = byCode.get(line.chargeItemCode);
          return (
            <li key={i} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
              <span className="tabular w-5 pb-2 text-sm text-muted-foreground" aria-hidden>
                {i + 1}
              </span>
              <div className="grid min-w-52 flex-1 gap-1.5">
                <Label htmlFor={`line-item-${i}`} className="text-xs text-muted-foreground">
                  Charge item
                </Label>
                <FieldSelect id={`line-item-${i}`} value={line.chargeItemCode} onChange={(v) => update(i, { chargeItemCode: v })} options={optionsFor(line.chargeItemCode)} placeholder="Choose an item" disabled={off} />
                {item && (
                  <span className="text-xs text-muted-foreground">
                    {chargeTypeLabel[item.type]}
                    {item.amount ? ` · catalog ${currency} ${amountText(BigInt(item.amount), currency)}` : item.type === "usage" ? " · priced by a tariff" : " · no amount yet"}
                  </span>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`line-qty-${i}`} className="text-xs text-muted-foreground">
                  Quantity
                </Label>
                <Input id={`line-qty-${i}`} value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} inputMode="numeric" className="w-20" disabled={off} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`line-amt-${i}`} className="text-xs text-muted-foreground">
                  Amount override ({currency})
                </Label>
                <Input id={`line-amt-${i}`} value={line.amountOverride} onChange={(e) => update(i, { amountOverride: e.target.value })} inputMode="decimal" placeholder="catalog" className="w-36" disabled={off} />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Checkbox id={`line-opt-${i}`} checked={line.optional} onCheckedChange={(v) => update(i, { optional: v === true })} disabled={off} />
                <Label htmlFor={`line-opt-${i}`} className="font-normal">
                  Optional
                </Label>
              </div>
              {canManage && (
                <div className="flex gap-0.5">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move line ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUpIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move line ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === drafts.length - 1}>
                    <ArrowDownIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setDrafts((d) => d.filter((_, j) => j !== i))}>
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setDrafts((d) => [...d, { chargeItemCode: "", quantity: "1", amountOverride: "", optional: false }])} disabled={drafts.length >= 30}>
            <PlusIcon />
            Add line
          </Button>
        </div>
      )}
      {changed && !checked.ok && (
        <ul role="status" className="grid gap-1 text-sm text-destructive">
          {checked.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {canManage && (
        <div className="flex gap-2">
          <Button
            disabled={!changed || !checked.ok || pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await setInvoiceLinesAction({ id, lines: drafts });
                if (result.error !== null) return setError(result.error);
                toast.success("Line template saved");
              });
            }}
          >
            {pending ? "Saving…" : "Save template"}
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setDrafts(initial)} disabled={pending}>
              Discard changes
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
