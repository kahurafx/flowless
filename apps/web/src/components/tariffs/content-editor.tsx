"use client";

import { money, type FlatBasis, type TariffType } from "@flowless/shared-types";
import { CircleAlertIcon, CircleCheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { MoneyText } from "@/components/money-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { flatKeyLabel } from "@/lib/tariff-labels";
import { addBand, chargeForUnits, parseDraft, removeBand, type ContentDraft } from "@/lib/tariff-content";

/**
 * The editor for a tariff version's content: bands (each band starts where the one before
 * ended, so they meet exactly), one uniform rate, or flat amounts. Problems show as you
 * type, from the same checks the server action runs. The API's `validateTariffContent`
 * remains the authority (the checks here mirror it and a test keeps them in step).
 */
export function ContentEditor({
  draft,
  onChange,
  shape,
  currency,
  locale,
  disabled = false,
}: {
  draft: ContentDraft;
  onChange: (draft: ContentDraft) => void;
  shape: { type: TariffType; flatBasis: FlatBasis };
  currency: string;
  locale: string;
  disabled?: boolean;
}) {
  const check = parseDraft(draft, shape, currency);
  const uid = useId();
  return (
    <div className="grid gap-4">
      {draft.type === "uniform" ? (
        <div className="grid max-w-xs gap-2">
          <Label htmlFor={`${uid}-rate`}>Rate per unit ({currency})</Label>
          <Input id={`${uid}-rate`} value={draft.rate} onChange={(e) => onChange({ ...draft, rate: e.target.value })} inputMode="decimal" placeholder="75.00" disabled={disabled} />
        </div>
      ) : draft.type === "flat_rate" ? (
        <FlatEditor draft={draft} onChange={onChange} basis={shape.flatBasis} currency={currency} disabled={disabled} uid={uid} />
      ) : (
        <BandEditor draft={draft} onChange={onChange} currency={currency} disabled={disabled} uid={uid} />
      )}

      {check.ok ? (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CircleCheckIcon className="size-4" aria-hidden /> The content is complete and consistent.
        </p>
      ) : (
        <ul role="status" className="grid gap-1 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
          {check.problems.map((problem) => (
            <li key={problem} className="flex items-start gap-1.5">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              {problem}
            </li>
          ))}
        </ul>
      )}

      {check.ok && check.content.type !== "flat_rate" && <TryReading bands={check.content.type === "uniform" ? [{ from: 0, to: null, rate: check.content.rate }] : check.content.bands} currency={currency} locale={locale} />}
    </div>
  );
}

function BandEditor({ draft, onChange, currency, disabled, uid }: { draft: Extract<ContentDraft, { bands: unknown }>; onChange: (d: ContentDraft) => void; currency: string; disabled: boolean; uid: string }) {
  const set = (bands: typeof draft.bands) => onChange({ ...draft, bands });
  // Each band starts after the end of the one before it (the first after 0).
  const starts: number[] = [];
  draft.bands.forEach((band, i) => {
    if (i === 0) return void starts.push(0);
    const previous = Number(draft.bands[i - 1]!.to);
    starts.push(draft.bands[i - 1]!.to.trim() !== "" && Number.isFinite(previous) ? previous : (starts[i - 1] ?? 0));
  });
  return (
    <div className="grid gap-2">
      {draft.bands.map((band, i) => {
        const last = i === draft.bands.length - 1;
        const start = starts[i] ?? 0;
        return (
          <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
            <span className="tabular w-5 pb-2 text-sm text-muted-foreground" aria-hidden>
              {i + 1}
            </span>
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">Starts after</span>
              <span className="tabular flex h-8 items-center text-sm">{start} {start === 1 ? "unit" : "units"}</span>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${uid}-to-${i}`} className="text-xs text-muted-foreground">
                Up to (units)
              </Label>
              <Input id={`${uid}-to-${i}`} value={band.to} onChange={(e) => set(draft.bands.map((b, j) => (j === i ? { ...b, to: e.target.value } : b)))} inputMode="numeric" placeholder={last ? "no limit" : "20"} disabled={disabled || last} className="w-28" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${uid}-rate-${i}`} className="text-xs text-muted-foreground">
                Rate per unit ({currency})
              </Label>
              <Input id={`${uid}-rate-${i}`} value={band.rate} onChange={(e) => set(draft.bands.map((b, j) => (j === i ? { ...b, rate: e.target.value } : b)))} inputMode="decimal" placeholder="82.50" disabled={disabled} className="w-36" />
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove band ${i + 1}`} onClick={() => set(removeBand(draft.bands, i))} disabled={disabled || draft.bands.length <= 1}>
              <Trash2Icon />
            </Button>
          </div>
        );
      })}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => set(addBand(draft.bands))} disabled={disabled || draft.bands.length >= 20}>
          <PlusIcon />
          Add band
        </Button>
      </div>
    </div>
  );
}

function FlatEditor({ draft, onChange, basis, currency, disabled, uid }: { draft: Extract<ContentDraft, { type: "flat_rate" }>; onChange: (d: ContentDraft) => void; basis: FlatBasis; currency: string; disabled: boolean; uid: string }) {
  const set = (amounts: typeof draft.amounts) => onChange({ ...draft, amounts });
  const keyed = basis !== "none";
  return (
    <div className="grid gap-2">
      {draft.amounts.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          {keyed && (
            <div className="grid gap-1">
              <Label htmlFor={`${uid}-key-${i}`} className="text-xs text-muted-foreground">
                {flatKeyLabel[basis]}
              </Label>
              <Input id={`${uid}-key-${i}`} value={row.key} onChange={(e) => set(draft.amounts.map((a, j) => (j === i ? { ...a, key: e.target.value } : a)))} placeholder={basis === "taps" ? "2" : basis === "pipe_size" ? '1/2"' : "House"} disabled={disabled} className="w-40" />
            </div>
          )}
          <div className="grid gap-1">
            <Label htmlFor={`${uid}-amount-${i}`} className="text-xs text-muted-foreground">
              Amount per month ({currency})
            </Label>
            <Input id={`${uid}-amount-${i}`} value={row.amount} onChange={(e) => set(draft.amounts.map((a, j) => (j === i ? { ...a, amount: e.target.value } : a)))} inputMode="decimal" placeholder="500.00" disabled={disabled} className="w-40" />
          </div>
          {keyed && (
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove amount ${i + 1}`} onClick={() => set(draft.amounts.filter((_, j) => j !== i))} disabled={disabled || draft.amounts.length <= 1}>
              <Trash2Icon />
            </Button>
          )}
        </div>
      ))}
      {keyed && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => set([...draft.amounts, { key: "", amount: "" }])} disabled={disabled}>
            <PlusIcon />
            Add {flatKeyLabel[basis].toLowerCase()}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A reading in whole units priced with the bands as typed, so a rate that looks right can be seen to be. */
function TryReading({ bands, currency, locale }: { bands: Parameters<typeof chargeForUnits>[0]; currency: string; locale: string }) {
  const id = useId();
  const [text, setText] = useState("15");
  const units = /^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
      <Label htmlFor={id} className="font-normal">
        Try a month&apos;s consumption of
      </Label>
      <Input id={id} value={text} onChange={(e) => setText(e.target.value)} inputMode="numeric" className="w-24" />
      <span className="text-muted-foreground">units costs</span>
      {units === null ? <span className="text-muted-foreground">enter whole units</span> : <MoneyText value={money(chargeForUnits(bands, units), currency)} locale={locale} className="font-semibold" />}
    </div>
  );
}
