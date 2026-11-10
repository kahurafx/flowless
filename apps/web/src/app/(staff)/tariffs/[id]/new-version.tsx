"use client";

import type { FlatBasis, TariffType } from "@flowless/shared-types";
import { PlusIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SimulateDialog } from "@/components/tariffs/simulate-dialog";
import type { SimulationOptions } from "@/data/billing-ops";
import { ContentEditor } from "@/components/tariffs/content-editor";
import { EffectiveDateField } from "@/components/tariffs/effective-date-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewEffectiveDate, type NextEffective } from "@/lib/effective-date";
import { emptyDraft, parseDraft, type ContentDraft } from "@/lib/tariff-content";
import { addVersionAction } from "../actions";

/** "New version" (T-01, T-03): starts from the content in force, dated by default at the next billing period start. */
export function NewVersion({
  tariffId,
  type,
  flatBasis,
  seed,
  next,
  existing,
  currency,
  locale,
  simulation,
}: {
  tariffId: string;
  type: TariffType;
  flatBasis: FlatBasis;
  seed: ContentDraft | null;
  next: NextEffective;
  existing: readonly string[];
  currency: string;
  locale: string;
  simulation: SimulationOptions | null;
}) {
  const shape = { type, flatBasis };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ContentDraft>(seed ?? emptyDraft(shape));
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <div>
        <Button
          variant="outline"
          onClick={() => {
            setDraft(seed ?? emptyDraft(shape));
            setError(null);
            setOpen(true);
          }}
        >
          <PlusIcon />
          New version
        </Button>
      </div>
    );
  }

  const check = parseDraft(draft, shape, currency);
  const date = previewEffectiveDate({ typed: effectiveFrom, next, existing, first: existing.length === 0, locale });
  return (
    <form
      className="grid gap-4 rounded-xl border bg-card p-4"
      aria-labelledby="new-version"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await addVersionAction({ tariffId, type, flatBasis, draft, effectiveFrom, note });
          if (result.error !== null) return setError(result.error);
          toast.success(`Version ${result.data.versionNo} added`);
          setOpen(false);
          setEffectiveFrom("");
          setNote("");
        });
      }}
    >
      <div>
        <h2 id="new-version" className="font-semibold">
          New version
        </h2>
        <p className="text-sm text-muted-foreground">Starts from the content in force. Saving adds a version; nothing already there is changed.</p>
      </div>
      <ContentEditor draft={draft} onChange={setDraft} shape={shape} currency={currency} locale={locale} />
      <EffectiveDateField id="version-date" value={effectiveFrom} onChange={setEffectiveFrom} next={next} existing={existing} first={existing.length === 0} locale={locale} />
      <div className="grid gap-2">
        <Label htmlFor="version-note">Reason (optional)</Label>
        <Input id="version-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Board resolution 14/2026" />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!check.ok || date.kind === "refused" || pending}>
          {pending ? "Saving…" : "Add version"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
        {simulation && <SimulateDialog type={type} flatBasis={flatBasis} draft={draft} currency={currency} options={simulation} />}
      </div>
    </form>
  );
}
