"use client";

import { PERMISSIONS, type ApprovalPolicy } from "@flowless/shared-types";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_APPROVAL_LEVELS, approvalPolicyFromForm, approvalPolicyToForm, type ApprovalPolicyForm } from "@/lib/account-settings";
import { permissionLabel } from "@/lib/permission-labels";
import { SettingShell, type SettingMeta } from "./setting-shell";
import { useDraft, type FormFrame } from "./use-draft";

const permissionOptions = PERMISSIONS.map((p) => ({ value: p, label: `${permissionLabel[p]} (${p})` }));

/**
 * An approval policy (K-05, K-10): the levels that decide in order, each by a permission and
 * optionally only for requests of at least an amount (smaller ones skip it; a request no level
 * applies to is approved at once), and when an undecided request is escalated. There is no
 * generic editor for these on a page of their own yet; this one serves the two approval kinds
 * of the Accounts module.
 */
export function ApprovalPolicySettingForm({
  meta,
  value,
  frame,
  title,
  description,
  amountHint,
}: {
  meta: SettingMeta;
  value: ApprovalPolicy;
  frame: FormFrame;
  title: string;
  description: string;
  /** What the minimum amount is measured against, for the label. */
  amountHint: string;
}) {
  const draft = useDraft<ApprovalPolicyForm>(approvalPolicyToForm(value, frame.currency));
  const form = draft.value;
  const setLevel = (i: number, patch: Partial<ApprovalPolicyForm["levels"][number]>) => draft.set({ ...form, levels: form.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const id = meta.key.replace(/\./g, "-");

  return (
    <SettingShell title={title} description={description} meta={meta} dirty={draft.dirty} build={() => approvalPolicyFromForm(draft.value, value, frame.currency)} onDiscard={draft.reset} {...frame}>
      {form.levels.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No levels: requests are approved at once, with nobody to decide them.</p>
      ) : (
        <ol className="grid gap-3">
          {form.levels.map((level, i) => (
            <li key={i} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
              <span className="tabular w-16 pb-2 text-sm text-muted-foreground">Level {i + 1}</span>
              <div className="grid min-w-40 flex-1 gap-1.5">
                <Label htmlFor={`${id}-label-${i}`} className="text-xs text-muted-foreground">
                  Name
                </Label>
                <Input id={`${id}-label-${i}`} value={level.label} onChange={(e) => setLevel(i, { label: e.target.value })} maxLength={80} placeholder="Manager" />
              </div>
              <div className="grid min-w-64 gap-1.5">
                <Label htmlFor={`${id}-perm-${i}`} className="text-xs text-muted-foreground">
                  Decided by members who can
                </Label>
                <FieldSelect id={`${id}-perm-${i}`} value={level.permission} onChange={(v) => setLevel(i, { permission: v })} options={permissionOptions} placeholder="Choose a permission" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-min-${i}`} className="text-xs text-muted-foreground">
                  Only {amountHint} of at least ({frame.currency})
                </Label>
                <Input id={`${id}-min-${i}`} value={level.minAmount} onChange={(e) => setLevel(i, { minAmount: e.target.value })} inputMode="decimal" placeholder="any" className="w-36" />
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove level ${i + 1}`} onClick={() => draft.set({ ...form, levels: form.levels.filter((_, j) => j !== i) })}>
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" disabled={form.levels.length >= MAX_APPROVAL_LEVELS} onClick={() => draft.set({ ...form, levels: [...form.levels, { label: "", permission: "", minAmount: "" }] })}>
          <PlusIcon />
          Add level
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-sla`}>Escalate after (hours)</Label>
          <Input id={`${id}-sla`} value={form.slaHours} onChange={(e) => draft.set({ ...form, slaHours: e.target.value })} inputMode="numeric" className="w-28" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-escalate`}>Then these members may decide too</Label>
          <FieldSelect id={`${id}-escalate`} value={form.escalateTo} onChange={(v) => draft.set({ ...form, escalateTo: v })} options={permissionOptions} placeholder="Nobody" none="Nobody (only raise it in the exception queue)" className="w-80 max-w-full" />
        </div>
      </div>
    </SettingShell>
  );
}
