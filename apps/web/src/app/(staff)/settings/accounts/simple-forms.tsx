"use client";

import { DATA_QUALITY_RULES } from "@flowless/shared-types";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SEVERITIES,
  applicationFromForm,
  applicationToForm,
  dataQualityFromForm,
  dataQualityToForm,
  membershipFromForm,
  membershipToForm,
  severityLabel,
  type ApplicationForm,
  type ApplicationValue,
  type DataQualityForm,
  type DataQualityValue,
  type MembershipValue,
} from "@/lib/account-settings";
import { SettingShell, type SettingMeta } from "./setting-shell";
import { useDraft, type FormFrame } from "./use-draft";

/** `accounts.application` (C-05, C-09): which stages an application goes through, and whether a relocation needs a survey. */
export function ApplicationSettingForm({ meta, value, frame }: { meta: SettingMeta; value: ApplicationValue; frame: FormFrame }) {
  const draft = useDraft<ApplicationForm>(applicationToForm(value));
  const form = draft.value;
  const rows: { key: keyof ApplicationForm; label: string; hint: string }[] = [
    { key: "survey", label: "Survey", hint: "A site survey, approved under the connection-survey approval policy below, before the application goes ahead." },
    { key: "invoice", label: "Invoice and payment", hint: "The new-connection invoice and its payment. Without it the application goes on with no invoice." },
    { key: "installation", label: "Installation", hint: "An installation stage before the connection is ready." },
    { key: "relocationSurvey", label: "Survey before a relocation", hint: "A survey must be recorded before a relocation can be completed." },
  ];
  return (
    <SettingShell
      title="Applications for new connections"
      description="Which stages an application goes through. A stage that is switched off is waived: applications skip it."
      meta={meta}
      dirty={draft.dirty}
      build={() => ({ ok: true, value: applicationFromForm(draft.value) })}
      onDiscard={draft.reset}
      {...frame}
    >
      <ul className="grid gap-3">
        {rows.map((row) => (
          <li key={row.key} className="flex items-start gap-3">
            <Checkbox id={`app-${row.key}`} className="mt-0.5" checked={form[row.key]} onCheckedChange={(v) => draft.set({ ...form, [row.key]: v === true })} />
            <div className="grid gap-0.5">
              <Label htmlFor={`app-${row.key}`}>{row.label}</Label>
              <span className="text-xs text-muted-foreground">{row.hint}</span>
            </div>
          </li>
        ))}
      </ul>
    </SettingShell>
  );
}

/** `accounts.membership` (C-07): classes of child accounts, each with an optional connection-fee item from the charge catalog. */
export function MembershipSettingForm({ meta, value, frame, chargeItems }: { meta: SettingMeta; value: MembershipValue; frame: FormFrame; chargeItems: { code: string; name: string; type: string }[] | null }) {
  const draft = useDraft(membershipToForm(value));
  const form = draft.value;
  const setClass = (i: number, patch: Partial<(typeof form.classes)[number]>) => draft.set({ classes: form.classes.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <SettingShell
      title="Membership classes"
      description="Classes a child account can belong to. A class can name the charge item priced as its members' connection fee, so a member pays differently from a stand-alone customer."
      meta={meta}
      dirty={draft.dirty}
      build={() => membershipFromForm(draft.value)}
      onDiscard={draft.reset}
      {...frame}
    >
      {form.classes.length === 0 && <p className="text-sm text-muted-foreground">No classes yet: child accounts have no membership class.</p>}
      <div className="grid gap-3">
        {form.classes.map((c, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor={`class-${i}`} className="text-xs text-muted-foreground">
                Class {c.key ? <span className="font-mono">({c.key})</span> : null}
              </Label>
              <Input id={`class-${i}`} value={c.label} onChange={(e) => setClass(i, { label: e.target.value })} maxLength={80} placeholder="Full member" />
            </div>
            <div className="grid min-w-56 gap-1.5">
              <Label htmlFor={`class-fee-${i}`} className="text-xs text-muted-foreground">
                Connection fee item
              </Label>
              {chargeItems ? (
                <FieldSelect
                  id={`class-fee-${i}`}
                  value={c.chargeItemCode}
                  onChange={(v) => setClass(i, { chargeItemCode: v })}
                  // An item already named stays visible even if it is no longer offered (deactivated or renamed).
                  options={[...chargeItems.map((x) => ({ value: x.code, label: `${x.name} (${x.code})` })), ...(c.chargeItemCode && !chargeItems.some((x) => x.code === c.chargeItemCode) ? [{ value: c.chargeItemCode, label: c.chargeItemCode }] : [])]}
                  placeholder="None"
                  none="None"
                />
              ) : (
                <Input id={`class-fee-${i}`} value={c.chargeItemCode} onChange={(e) => setClass(i, { chargeItemCode: e.target.value })} className="font-mono" placeholder="member_connection_fee" maxLength={40} />
              )}
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove class ${i + 1}`} onClick={() => draft.set({ classes: form.classes.filter((_, j) => j !== i) })}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
      {!chargeItems && <p className="text-xs text-muted-foreground">Tariffs is not available to you, so the charge item is typed by its code.</p>}
      <div>
        <Button type="button" variant="outline" size="sm" disabled={form.classes.length >= 30} onClick={() => draft.set({ classes: [...form.classes, { key: "", label: "", chargeItemCode: "" }] })}>
          <PlusIcon />
          Add class
        </Button>
      </div>
    </SettingShell>
  );
}

/** `accounts.data_quality` (C-12): for each rule whether it runs, how serious its findings are and whether the sweep raises exceptions. */
export function DataQualitySettingForm({ meta, value, frame }: { meta: SettingMeta; value: DataQualityValue; frame: FormFrame }) {
  const draft = useDraft<DataQualityForm>(dataQualityToForm(value));
  const form = draft.value;
  return (
    <SettingShell
      title="Data quality rules"
      description="Each rule looks for accounts with something missing or doubtful. A rule can be switched off, graded by severity and, if you want it chased, raise one exception per finding in the exception queue (checked hourly)."
      meta={meta}
      dirty={draft.dirty}
      build={() => ({ ok: true, value: dataQualityFromForm(draft.value, value) })}
      onDiscard={draft.reset}
      {...frame}
    >
      <ul className="grid gap-3">
        {DATA_QUALITY_RULES.map((rule) => {
          const r = form[rule.key];
          const set = (patch: Partial<typeof r>) => draft.set({ ...form, [rule.key]: { ...r, ...patch } });
          return (
            <li key={rule.key} className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {rule.label}
                  {rule.source === "metering" && <Badge variant="outline">Decided by Metering</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">{rule.description}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <div className="flex items-center gap-1.5">
                  <Checkbox id={`dq-${rule.key}-on`} checked={r.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
                  <Label htmlFor={`dq-${rule.key}-on`} className="font-normal">
                    Runs
                  </Label>
                </div>
                <FieldSelect
                  id={`dq-${rule.key}-sev`}
                  value={r.severity}
                  onChange={(v) => set({ severity: v as typeof r.severity })}
                  options={SEVERITIES.map((s) => ({ value: s, label: severityLabel[s] }))}
                  placeholder="Severity"
                  disabled={!r.enabled}
                  className="w-32"
                />
                <div className="flex items-center gap-1.5">
                  <Checkbox id={`dq-${rule.key}-exc`} checked={r.raiseExceptions} disabled={!r.enabled} onCheckedChange={(v) => set({ raiseExceptions: v === true })} />
                  <Label htmlFor={`dq-${rule.key}-exc`} className="font-normal">
                    Raise exceptions
                  </Label>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </SettingShell>
  );
}
