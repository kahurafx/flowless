"use client";

import { AlertTriangleIcon, CalendarCheckIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewEffectiveDate, type NextEffective } from "@/lib/effective-date";
import { cn } from "@/lib/utils";

/**
 * The effective-date input of a tariff, category or charge change (T-03): empty means the
 * next billing period start, and the line under it says exactly when the change takes
 * effect or why it would be refused. The server decides; this is early, plain wayfinding.
 */
export function EffectiveDateField({
  id,
  value,
  onChange,
  next,
  existing,
  first = false,
  locale,
  label = "Takes effect",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  next: NextEffective;
  existing: readonly string[];
  first?: boolean;
  locale: string;
  label?: string;
}) {
  const preview = previewEffectiveDate({ typed: value, next, existing, first, locale });
  const refused = preview.kind === "refused";
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} className="w-auto" aria-describedby={`${id}-preview`} aria-invalid={refused} />
        {value !== "" && (
          <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => onChange("")}>
            Use the default
          </button>
        )}
      </div>
      <p id={`${id}-preview`} className={cn("flex items-start gap-1.5 text-sm", refused ? "text-destructive" : "text-muted-foreground")} role={refused ? "alert" : undefined}>
        {refused ? <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CalendarCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span>{preview.message}</span>
      </p>
    </div>
  );
}
