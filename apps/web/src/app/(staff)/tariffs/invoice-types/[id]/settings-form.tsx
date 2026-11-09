"use client";

import { PAYMENT_TERMS_KINDS, allowedOverdueActions, type InvoiceAppliesTo, type OverdueAction } from "@flowless/shared-types";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formFromType, numberSample, updateFromForm, type InvoiceTypeForm, type InvoiceTypeView } from "@/lib/invoice-type-form";
import { appliesToLabel, overdueActionLabel, termsKindLabel } from "@/lib/tariff-labels";
import { updateInvoiceTypeAction } from "../../actions";

/** Numbering, days to pay, payment terms and the overdue policy of one invoice type (T-08, T-09). */
export function SettingsForm({ type, nextNumber, currency, canManage }: { type: InvoiceTypeView & { id: string }; nextNumber: string; currency: string; canManage: boolean }) {
  const initial = formFromType(type, currency);
  const [form, setForm] = useState<InvoiceTypeForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof InvoiceTypeForm>(key: K, value: InvoiceTypeForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const checked = updateFromForm(form, type.appliesTo, currency);
  const changed = JSON.stringify(form) !== JSON.stringify(initial);
  const off = !canManage;
  const width = Number(form.width);
  const start = Number(form.start);

  return (
    <form
      className="grid gap-5 rounded-xl border bg-card p-4"
      aria-labelledby="invoice-settings"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await updateInvoiceTypeAction({ id: type.id, appliesTo: type.appliesTo, form });
          if (result.error !== null) return setError(result.error);
          toast.success("Invoice type saved");
        });
      }}
    >
      <div>
        <h2 id="invoice-settings" className="font-semibold">
          Numbering, terms and overdue policy
        </h2>
        <p className="text-sm text-muted-foreground">Bills {appliesToLabel[type.appliesTo as InvoiceAppliesTo].toLowerCase()}. The code and what it bills cannot change.</p>
      </div>

      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="it-name">Name</Label>
        <Input id="it-name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} disabled={off} />
      </div>

      <fieldset className="grid gap-3" disabled={off}>
        <legend className="mb-1 text-sm font-medium">Invoice numbers</legend>
        <div className="flex flex-wrap gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="it-prefix">Prefix</Label>
            <Input id="it-prefix" value={form.prefix} onChange={(e) => set("prefix", e.target.value)} maxLength={12} className="w-28 font-mono" placeholder="INV-" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="it-width">Digits</Label>
            <Input id="it-width" value={form.width} onChange={(e) => set("width", e.target.value)} inputMode="numeric" className="w-20" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="it-start">First number</Label>
            <Input id="it-start" value={form.start} onChange={(e) => set("start", e.target.value)} inputMode="numeric" className="w-28" />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {Number.isInteger(width) && Number.isInteger(start) && width >= 1 && start >= 1 ? (
            <>
              The first number would look like <span className="font-mono text-foreground">{numberSample(form.prefix.trim(), width, start)}</span>.{" "}
            </>
          ) : null}
          The next invoice will be <span className="font-mono text-foreground">{nextNumber}</span>. Raising the first number skips ahead; lowering it never reuses a number.
        </p>
      </fieldset>

      <fieldset className="grid gap-3" disabled={off}>
        <legend className="mb-1 text-sm font-medium">Payment terms</legend>
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="it-due">Days to pay</Label>
            <Input id="it-due" value={form.dueDays} onChange={(e) => set("dueDays", e.target.value)} inputMode="numeric" className="w-24" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="it-terms">Terms</Label>
            <FieldSelect id="it-terms" value={form.termsKind} onChange={(v) => set("termsKind", v as InvoiceTypeForm["termsKind"])} options={PAYMENT_TERMS_KINDS.map((k) => ({ value: k, label: termsKindLabel[k] }))} placeholder="Choose terms" className="w-56" />
          </div>
        </div>
        {form.termsKind === "minimum_deposit" && (
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="it-deposit-basis">Deposit is</Label>
              <FieldSelect
                id="it-deposit-basis"
                value={form.depositBasis}
                onChange={(v) => set("depositBasis", v as "percent" | "amount")}
                options={[{ value: "percent", label: "A percentage of the total" }, { value: "amount", label: "A fixed amount" }]}
                placeholder="Choose"
                className="w-56"
              />
            </div>
            {form.depositBasis === "percent" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="it-deposit-pct">Percentage</Label>
                <Input id="it-deposit-pct" value={form.depositPercent} onChange={(e) => set("depositPercent", e.target.value)} inputMode="decimal" className="w-24" placeholder="25" />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="it-deposit-amt">Amount ({currency})</Label>
                <Input id="it-deposit-amt" value={form.depositAmount} onChange={(e) => set("depositAmount", e.target.value)} inputMode="decimal" className="w-36" placeholder="1500.00" />
              </div>
            )}
          </div>
        )}
        {form.termsKind === "installments" && (
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="it-count">Installments</Label>
              <Input id="it-count" value={form.installmentCount} onChange={(e) => set("installmentCount", e.target.value)} inputMode="numeric" className="w-24" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="it-interval">Days apart</Label>
              <Input id="it-interval" value={form.installmentInterval} onChange={(e) => set("installmentInterval", e.target.value)} inputMode="numeric" className="w-24" />
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3" disabled={off}>
        <legend className="mb-1 text-sm font-medium">When an invoice is overdue</legend>
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="it-overdue">Then</Label>
            <FieldSelect
              id="it-overdue"
              value={form.overdueAction}
              onChange={(v) => set("overdueAction", v as OverdueAction)}
              options={allowedOverdueActions(type.appliesTo).map((a) => ({ value: a, label: overdueActionLabel[a] }))}
              placeholder="Choose"
              className="w-60"
            />
          </div>
          {form.overdueAction !== "none" && (
            <div className="grid gap-1.5">
              <Label htmlFor="it-overdue-days">Days after the due date</Label>
              <Input id="it-overdue-days" value={form.overdueAfterDays} onChange={(e) => set("overdueAfterDays", e.target.value)} inputMode="numeric" className="w-24" />
            </div>
          )}
        </div>
        {type.appliesTo === "application" && <p className="text-xs text-muted-foreground">An unpaid application invoice pauses or cancels the application; it never disconnects.</p>}
      </fieldset>

      <div className="flex items-center gap-2">
        <Checkbox id="it-active" checked={form.active} onCheckedChange={(v) => set("active", v === true)} disabled={off} />
        <Label htmlFor="it-active" className="font-normal">
          In use for new invoices
        </Label>
      </div>

      {!checked.ok && changed && (
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
          <Button type="submit" disabled={!changed || !checked.ok || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {changed && (
            <Button type="button" variant="ghost" onClick={() => setForm(initial)} disabled={pending}>
              Discard changes
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
