"use client";

import { SearchIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QUALITY_LABELS } from "@/lib/metering-view";
import { findMeterBySerialAction } from "@/app/(staff)/metering/actions";

export interface FoundMeter {
  id: string;
  serial: string;
  dialDigits: number;
  status: string;
}

/** Finds a meter by its exact serial number. */
export function MeterPicker({ id, label = "Meter serial", found, onFound }: { id: string; label?: string; found: FoundMeter | null; onFound: (m: FoundMeter | null) => void }) {
  const [serial, setSerial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const find = () =>
    start(async () => {
      const result = await findMeterBySerialAction(serial);
      if (result.error !== null) {
        setError(result.error);
        onFound(null);
      } else {
        setError(null);
        onFound(result.data);
      }
    });
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={serial}
          onChange={(e) => {
            setSerial(e.target.value);
            if (found) onFound(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              find();
            }
          }}
          placeholder="Type the serial, then Find"
        />
        <Button type="button" variant="outline" onClick={find} disabled={pending || serial.trim() === ""}>
          <SearchIcon />
          Find
        </Button>
      </div>
      {found && (
        <p className="text-xs text-muted-foreground">
          {found.serial}: {found.dialDigits}-digit dial, status {found.status.replace("_", " ")}
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface ReadingDraft {
  value: string;
  quality: string;
  note: string;
  rollover: boolean;
}
export const emptyReading: ReadingDraft = { value: "", quality: "good", note: "", rollover: false };

/** A dial reading with the reader's judgement and a note; `digits` limits what can be typed. */
export function ReadingFields({ idPrefix, draft, onChange, digits, legend }: { idPrefix: string; draft: ReadingDraft; onChange: (d: ReadingDraft) => void; digits?: number | undefined; legend: string }) {
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-value`}>Dial{digits ? ` (${digits} digits)` : ""}</Label>
          <Input id={`${idPrefix}-value`} value={draft.value} onChange={(e) => onChange({ ...draft, value: e.target.value })} inputMode="numeric" maxLength={digits ?? 12} className="w-36 tabular" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-quality`}>Quality</Label>
          <FieldSelect id={`${idPrefix}-quality`} value={draft.quality} onChange={(v) => onChange({ ...draft, quality: v || "good" })} options={Object.entries(QUALITY_LABELS).map(([value, label]) => ({ value, label }))} placeholder="Quality" className="w-32" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id={`${idPrefix}-rollover`} checked={draft.rollover} onCheckedChange={(v) => onChange({ ...draft, rollover: v === true })} />
        <Label htmlFor={`${idPrefix}-rollover`} className="font-normal">
          The dial went round past its highest number (rollover)
        </Label>
      </div>
      <Textarea value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })} rows={2} maxLength={1000} placeholder="Note (optional)" aria-label={`${legend} note`} />
    </fieldset>
  );
}
