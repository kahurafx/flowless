"use client";

import { FLAT_BASES, TARIFF_TYPES, type FlatBasis, type TariffType } from "@flowless/shared-types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { ContentEditor } from "@/components/tariffs/content-editor";
import { EffectiveDateField } from "@/components/tariffs/effective-date-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewEffectiveDate, type NextEffective } from "@/lib/effective-date";
import { emptyDraft, parseDraft, type ContentDraft } from "@/lib/tariff-content";
import { flatBasisLabel, tariffTypeHint, tariffTypeLabel } from "@/lib/tariff-labels";
import { createTariffAction } from "../actions";

export function NewTariffForm({ next, currency, locale }: { next: NextEffective; currency: string; locale: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState<TariffType>("increasing_block");
  const [flatBasis, setFlatBasis] = useState<FlatBasis>("none");
  const [draft, setDraft] = useState<ContentDraft>(emptyDraft({ type: "increasing_block", flatBasis: "none" }));
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const shape = { type, flatBasis: type === "flat_rate" ? flatBasis : ("none" as const) };
  const reshape = (nextType: TariffType, nextBasis: FlatBasis) => {
    setType(nextType);
    setFlatBasis(nextBasis);
    setDraft(emptyDraft({ type: nextType, flatBasis: nextType === "flat_rate" ? nextBasis : "none" }));
  };
  const check = parseDraft(draft, shape, currency);
  const date = previewEffectiveDate({ typed: effectiveFrom, next, existing: [], first: true, locale });
  const canSave = name.trim() !== "" && check.ok && date.kind !== "refused";

  return (
    <form
      className="grid max-w-3xl gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await createTariffAction({ name, type, flatBasis, draft, effectiveFrom, note });
          if (result.error !== null) return setError(result.error);
          toast.success("Tariff created");
          router.push(`/tariffs/${result.data}`);
        });
      }}
    >
      <section className="grid gap-4 rounded-xl border bg-card p-4">
        <div className="grid gap-2 sm:max-w-sm">
          <Label htmlFor="tariff-name">Name</Label>
          <Input id="tariff-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Domestic metered" required />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="tariff-type">How it prices</Label>
            <FieldSelect id="tariff-type" value={type} onChange={(v) => reshape(v as TariffType, flatBasis)} options={TARIFF_TYPES.map((t) => ({ value: t, label: tariffTypeLabel[t] }))} placeholder="Choose a type" />
            <p className="text-xs text-muted-foreground">{tariffTypeHint[type]}</p>
          </div>
          {type === "flat_rate" && (
            <div className="grid gap-2">
              <Label htmlFor="tariff-basis">The amount depends on</Label>
              <FieldSelect id="tariff-basis" value={flatBasis} onChange={(v) => reshape(type, v as FlatBasis)} options={FLAT_BASES.map((b) => ({ value: b, label: flatBasisLabel[b] }))} placeholder="Choose a basis" />
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border bg-card p-4">
        <h2 className="font-semibold">First version</h2>
        <ContentEditor draft={draft} onChange={setDraft} shape={shape} currency={currency} locale={locale} />
      </section>

      <section className="grid gap-4 rounded-xl border bg-card p-4">
        <EffectiveDateField id="tariff-date" value={effectiveFrom} onChange={setEffectiveFrom} next={next} existing={[]} first locale={locale} />
        <div className="grid gap-2">
          <Label htmlFor="tariff-note">Note (optional)</Label>
          <Input id="tariff-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Board resolution 14/2026" />
        </div>
      </section>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!canSave || pending}>
          {pending ? "Creating…" : "Create tariff"}
        </Button>
      </div>
    </form>
  );
}
