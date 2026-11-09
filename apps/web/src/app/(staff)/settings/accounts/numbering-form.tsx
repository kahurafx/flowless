"use client";

import { CHECK_DIGIT_SCHEMES } from "@flowless/shared-types";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sampleNumbers } from "@/lib/account-number";
import { checkDigitLabel, numberingFromForm, numberingToForm, separatorLabel, type NumberingForm, type NumberingValue } from "@/lib/account-settings";
import { SettingShell, type SettingMeta } from "./setting-shell";
import { useDraft, type FormFrame } from "./use-draft";

/** `accounts.numbering` (C-02): prefix, digits, first number, check digit and separator, with a preview of what it would issue. */
export function NumberingSettingForm({ meta, value, nextNumber, frame }: { meta: SettingMeta; value: NumberingValue; nextNumber: string; frame: FormFrame }) {
  const draft = useDraft<NumberingForm>(numberingToForm(value));
  const form = draft.value;
  const set = <K extends keyof NumberingForm>(key: K, v: NumberingForm[K]) => draft.set({ ...form, [key]: v });
  const built = numberingFromForm(form, value);
  const samples = built.ok ? sampleNumbers(built.value) : [];

  return (
    <SettingShell
      title="Account numbers"
      description="The format of new account numbers. Numbers already issued are never changed; raising the first number skips ahead, and lowering it never reuses one. Child accounts add letters to their parent's number."
      meta={meta}
      dirty={draft.dirty}
      build={() => numberingFromForm(draft.value, value)}
      onDiscard={draft.reset}
      {...frame}
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="num-prefix">Prefix</Label>
          <Input id="num-prefix" value={form.prefix} onChange={(e) => set("prefix", e.target.value.toUpperCase())} maxLength={8} className="w-28 font-mono" placeholder="MJ" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="num-width">Digits</Label>
          <Input id="num-width" value={form.width} onChange={(e) => set("width", e.target.value)} inputMode="numeric" className="w-20" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="num-start">First number</Label>
          <Input id="num-start" value={form.start} onChange={(e) => set("start", e.target.value)} inputMode="numeric" className="w-28" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="num-check">Check digit</Label>
          <FieldSelect id="num-check" value={form.checkDigit} onChange={(v) => set("checkDigit", v as NumberingForm["checkDigit"])} options={CHECK_DIGIT_SCHEMES.map((c) => ({ value: c, label: checkDigitLabel[c] }))} placeholder="Choose" className="w-64" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="num-sep">Separator</Label>
          <FieldSelect
            id="num-sep"
            value={form.separator === "" ? "none" : form.separator}
            onChange={(v) => set("separator", v === "none" ? "" : (v as NumberingForm["separator"]))}
            options={(Object.keys(separatorLabel) as NumberingValue["separator"][]).map((s) => ({ value: s === "" ? "none" : s, label: separatorLabel[s] }))}
            placeholder="Choose"
            className="w-36"
          />
        </div>
      </div>
      <div className="grid gap-1 rounded-lg bg-muted/40 p-3 text-sm" aria-live="polite">
        <p>
          Next account number now: <span className="font-mono font-medium">{nextNumber}</span>
        </p>
        {draft.dirty && (
          <p>
            With these changes, from the first number:{" "}
            {built.ok ? (
              <span className="font-mono font-medium">{samples.join(", ")}</span>
            ) : (
              <span className="text-muted-foreground">fix the fields above to see a preview</span>
            )}
            {built.ok && samples[0] && <span className="text-muted-foreground"> (a child account would be {samples[0]}A)</span>}
          </p>
        )}
      </div>
    </SettingShell>
  );
}
