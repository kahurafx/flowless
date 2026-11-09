"use client";

import { ACTIVATION_GATE_KEYS, ACTIVATION_MODES, type ActivationConfig, type ActivationGateKey } from "@flowless/shared-types";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activationFromForm, activationToForm, gateLabel, type ActivationForm } from "@/lib/account-settings";
import { SettingShell, type SettingMeta } from "./setting-shell";
import { useDraft, type FormFrame } from "./use-draft";

const modeLabel = { checklist: "Office checklist: staff activate once the gates are met", auto: "Automatic: activate by itself when the last gate is met" } as const;

/** `accounts.activation` (C-06): mode, the gates and which are required, the payment threshold, the office checklist and the stale-account limit. */
export function ActivationSettingForm({ meta, value, frame }: { meta: SettingMeta; value: ActivationConfig; frame: FormFrame }) {
  const draft = useDraft<ActivationForm>(activationToForm(value, frame.currency));
  const form = draft.value;
  const gate = (key: ActivationGateKey) => form.gates[key];
  const setGate = (key: ActivationGateKey, patch: Partial<ActivationForm["gates"][ActivationGateKey]>) =>
    draft.set({ ...form, gates: { ...form.gates, [key]: { ...form.gates[key], ...patch } } });
  const setItem = (i: number, patch: Partial<ActivationForm["officeChecklist"][number]>) => draft.set({ ...form, officeChecklist: form.officeChecklist.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const pay = form.gates.payment_threshold;

  return (
    <SettingShell
      title="Account activation"
      description="How an account goes live. Gates are the facts that must hold first; an enabled gate that is not required is shown but does not hold activation back. The office checklist adds items staff tick by hand."
      meta={meta}
      dirty={draft.dirty}
      build={() => activationFromForm(draft.value, frame.currency)}
      onDiscard={draft.reset}
      {...frame}
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="act-mode">Activation</Label>
          <FieldSelect id="act-mode" value={form.mode} onChange={(v) => draft.set({ ...form, mode: v as ActivationForm["mode"] })} options={ACTIVATION_MODES.map((m) => ({ value: m, label: modeLabel[m] }))} placeholder="Choose" className="w-[26rem] max-w-full" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="act-stale">Raise as stale after (days)</Label>
          <Input id="act-stale" value={form.staleAfterDays} onChange={(e) => draft.set({ ...form, staleAfterDays: e.target.value })} inputMode="numeric" className="w-28" />
        </div>
      </div>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Gates</legend>
        {ACTIVATION_GATE_KEYS.map((key) => (
          <div key={key} className="grid gap-2 border-b pb-3 last:border-0 last:pb-0">
            <p className="text-sm">{gateLabel[key]}</p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="flex items-center gap-1.5">
                <Checkbox id={`gate-${key}-on`} checked={gate(key).enabled} onCheckedChange={(v) => setGate(key, { enabled: v === true })} />
                <Label htmlFor={`gate-${key}-on`} className="font-normal">
                  Used
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <Checkbox id={`gate-${key}-req`} checked={gate(key).required} disabled={!gate(key).enabled} onCheckedChange={(v) => setGate(key, { required: v === true })} />
                <Label htmlFor={`gate-${key}-req`} className="font-normal">
                  Required
                </Label>
              </div>
            </div>
            {key === "payment_threshold" && pay.enabled && (
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="gate-pay-basis">Threshold is</Label>
                  <FieldSelect
                    id="gate-pay-basis"
                    value={pay.basis}
                    onChange={(v) => setGate("payment_threshold", { basis: v as "percent" | "fixed" })}
                    options={[{ value: "percent", label: "A share of the new-connection invoice" }, { value: "fixed", label: "A fixed amount" }]}
                    placeholder="Choose"
                    className="w-72"
                  />
                </div>
                {pay.basis === "percent" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="gate-pay-pct">Percent paid</Label>
                    <Input id="gate-pay-pct" value={pay.percent} onChange={(e) => setGate("payment_threshold", { percent: e.target.value })} inputMode="numeric" className="w-24" />
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="gate-pay-fixed">Amount paid ({frame.currency})</Label>
                    <Input id="gate-pay-fixed" value={pay.fixedAmount} onChange={(e) => setGate("payment_threshold", { fixedAmount: e.target.value })} inputMode="decimal" className="w-36" />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Office checklist</legend>
        {form.officeChecklist.length === 0 && <p className="text-sm text-muted-foreground">No extra items. Add one for something staff must confirm by hand, such as “Site visit signed off”.</p>}
        {form.officeChecklist.map((item, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-56 flex-1 gap-1.5">
              <Label htmlFor={`item-${i}`} className="text-xs text-muted-foreground">
                Item {item.key ? <span className="font-mono">({item.key})</span> : null}
              </Label>
              <Input id={`item-${i}`} value={item.label} onChange={(e) => setItem(i, { label: e.target.value })} maxLength={120} placeholder="Site visit signed off" />
            </div>
            <div className="flex items-center gap-1.5 pb-2">
              <Checkbox id={`item-${i}-on`} checked={item.enabled} onCheckedChange={(v) => setItem(i, { enabled: v === true })} />
              <Label htmlFor={`item-${i}-on`} className="font-normal">
                Used
              </Label>
            </div>
            <div className="flex items-center gap-1.5 pb-2">
              <Checkbox id={`item-${i}-req`} checked={item.required} disabled={!item.enabled} onCheckedChange={(v) => setItem(i, { required: v === true })} />
              <Label htmlFor={`item-${i}-req`} className="font-normal">
                Required
              </Label>
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove item ${i + 1}`} onClick={() => draft.set({ ...form, officeChecklist: form.officeChecklist.filter((_, j) => j !== i) })}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" disabled={form.officeChecklist.length >= 20} onClick={() => draft.set({ ...form, officeChecklist: [...form.officeChecklist, { key: "", label: "", enabled: true, required: true }] })}>
            <PlusIcon />
            Add item
          </Button>
        </div>
      </fieldset>
    </SettingShell>
  );
}
