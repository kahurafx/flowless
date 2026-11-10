"use client";

import { DISPOSITIONS, READING_OUTCOMES } from "@flowless/shared-types";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DISPOSITION_LABELS,
  OUTCOME_FIELD_LABELS,
  POLICY_SPECS,
  emptySchedule,
  outcomesFromForm,
  outcomesToForm,
  schedulesFromForm,
  schedulesToForm,
  valueFromForm,
  valueToForm,
  type FieldSpec,
  type OutcomeForm,
  type ScheduleRow,
} from "@/lib/policy-settings";
import { SettingShell, type SettingMeta } from "./accounts/setting-shell";
import { useDraft, type FormFrame } from "./accounts/use-draft";

function Field({ spec, value, onChange, currency }: { spec: FieldSpec; value: string; onChange: (v: string) => void; currency: string }) {
  const id = `f-${spec.path.replace(/\./g, "-")}`;
  if (spec.kind === "bool") {
    return (
      <div className="flex items-start gap-3">
        <Checkbox id={id} className="mt-0.5" checked={value === "true"} onCheckedChange={(v) => onChange(v === true ? "true" : "false")} />
        <div className="grid gap-0.5">
          <Label htmlFor={id}>{spec.label}</Label>
          {spec.hint && <span className="text-xs text-muted-foreground">{spec.hint}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{spec.label}</Label>
      {spec.kind === "select" ? (
        <FieldSelect id={id} value={value} onChange={onChange} options={spec.options ?? []} placeholder="Choose" />
      ) : spec.kind === "textarea" ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={500} />
      ) : (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode={spec.kind === "text" ? "text" : "decimal"}
            className={spec.kind === "text" ? "max-w-sm" : "w-40"}
            placeholder={spec.nullable ? "None" : undefined}
          />
          {spec.kind === "money" && <span className="text-sm text-muted-foreground">{currency}</span>}
        </div>
      )}
      {spec.hint && <span className="text-xs text-muted-foreground">{spec.hint}</span>}
    </div>
  );
}

/** A setting described by `POLICY_SPECS`: its fields, saved as a new version (K-10). */
export function PolicySettingForm({ settingKey, meta, value, frame }: { settingKey: string; meta: SettingMeta; value: unknown; frame: FormFrame }) {
  const spec = POLICY_SPECS[settingKey]!;
  const draft = useDraft(valueToForm(spec, value, frame.currency));
  return (
    <SettingShell
      title={spec.title}
      description={spec.description}
      meta={meta}
      dirty={draft.dirty}
      build={() => valueFromForm(spec, draft.value, frame.currency, value)}
      onDiscard={draft.reset}
      {...frame}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {spec.fields.map((f) => (
          <div key={f.path} className={f.kind === "textarea" ? "sm:col-span-2" : undefined}>
            <Field spec={f} value={draft.value[f.path] ?? ""} onChange={(v) => draft.set({ ...draft.value, [f.path]: v })} currency={frame.currency} />
          </div>
        ))}
      </div>
    </SettingShell>
  );
}

/** M-06: what billing does for each thing a reader can find. Left on "engine default" it is not stored. */
export function OutcomesSettingForm({ meta, value, frame }: { meta: SettingMeta; value: unknown; frame: FormFrame }) {
  const draft = useDraft<OutcomeForm>(outcomesToForm(value));
  return (
    <SettingShell
      title="Reading outcomes"
      description="What billing does for each thing a reader can find at the meter. Only the outcomes you change are stored; the rest follow the billing engine's defaults."
      meta={meta}
      dirty={draft.dirty}
      build={() => outcomesFromForm(draft.value)}
      onDiscard={draft.reset}
      {...frame}
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {READING_OUTCOMES.map((o) => (
          <li key={o} className="grid gap-1.5">
            <Label htmlFor={`outcome-${o}`}>{OUTCOME_FIELD_LABELS[o]}</Label>
            <FieldSelect
              id={`outcome-${o}`}
              value={draft.value[o]}
              onChange={(v) => draft.set({ ...draft.value, [o]: DISPOSITIONS.find((d) => d === v) ?? "" })}
              options={DISPOSITIONS.map((d) => ({ value: d, label: DISPOSITION_LABELS[d] }))}
              placeholder="Engine default"
              none="Engine default"
            />
          </li>
        ))}
      </ul>
    </SettingShell>
  );
}

/** M-12: how often each DMA's bulk meters are read. */
export function BulkSchedulesForm({ meta, value, frame, dmas }: { meta: SettingMeta; value: unknown; frame: FormFrame; dmas: { value: string; label: string }[] }) {
  const draft = useDraft<ScheduleRow[]>(schedulesToForm(value));
  const rows = draft.value;
  const set = (i: number, patch: Partial<ScheduleRow>) => draft.set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <SettingShell
      title="Bulk meter schedules"
      description="How often the bulk meters of each DMA are read, counted in days from a start date. A DMA with no schedule has none."
      meta={meta}
      dirty={draft.dirty}
      build={() => schedulesFromForm(rows)}
      onDiscard={draft.reset}
      {...frame}
    >
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No schedules yet.</p>}
      <div className="grid gap-3">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
            <div className="grid min-w-48 flex-1 gap-1.5">
              <Label htmlFor={`sched-dma-${i}`}>DMA</Label>
              <FieldSelect id={`sched-dma-${i}`} value={r.dmaId} onChange={(v) => set(i, { dmaId: v })} options={dmas} placeholder="Choose a DMA" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`sched-days-${i}`}>Every (days)</Label>
              <Input id={`sched-days-${i}`} value={r.everyDays} onChange={(e) => set(i, { everyDays: e.target.value })} inputMode="numeric" className="w-24" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`sched-start-${i}`}>From</Label>
              <Input id={`sched-start-${i}`} type="date" value={r.startDate} onChange={(e) => set(i, { startDate: e.target.value })} className="w-auto" />
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove schedule ${i + 1}`} onClick={() => draft.set(rows.filter((_, j) => j !== i))}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button type="button" variant="outline" onClick={() => draft.set([...rows, emptySchedule])}>
          <PlusIcon />
          Add a schedule
        </Button>
      </div>
    </SettingShell>
  );
}
