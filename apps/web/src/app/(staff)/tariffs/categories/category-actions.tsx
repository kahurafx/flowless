"use client";

import { ArrowRightIcon, LinkIcon, PencilIcon, PlusIcon, PowerIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { EffectiveDateField } from "@/components/tariffs/effective-date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewEffectiveDate, type NextEffective } from "@/lib/effective-date";
import {
  ASSIGNMENT_KEYS,
  KEEP,
  assignmentChanged,
  assignmentKeyLabel,
  assignmentOutcome,
  inForceOn,
  keepAll,
  type AssignmentChoice,
  type AssignmentKey,
} from "@/lib/tariff-view";
import { assignTariffAction, createCategoryAction, renameCategoryAction, setCategoryActiveAction } from "../actions";

/** A category code is lower-case letters, digits and underscores, starting with a letter; made from the name until the person types one. */
const codeFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 40);

export function NewCategory() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const shownCode = codeTouched ? code : codeFrom(name);
  return (
    <ActionDialog
      label="New category"
      icon={<PlusIcon />}
      variant="default"
      title="New category"
      description="A category groups accounts that are priced alike. Its code is permanent; the name can change."
      submitLabel="Create category"
      success="Category created"
      canSubmit={name.trim() !== "" && shownCode !== ""}
      onOpen={() => {
        setName("");
        setCode("");
        setCodeTouched(false);
      }}
      onSubmit={() => createCategoryAction({ code: shownCode, name })}
    >
      <div className="grid gap-2">
        <Label htmlFor="category-name">Name</Label>
        <Input id="category-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Schools" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="category-code">Code</Label>
        <Input
          id="category-code"
          value={shownCode}
          onChange={(e) => {
            setCodeTouched(true);
            setCode(e.target.value);
          }}
          maxLength={40}
          className="font-mono"
          placeholder="schools"
        />
        <p className="text-xs text-muted-foreground">Lower-case letters, digits and underscores, starting with a letter.</p>
      </div>
    </ActionDialog>
  );
}

export function CategoryButtons({ id, name, active }: { id: string; name: string; active: boolean }) {
  const [text, setText] = useState(name);
  return (
    <>
      <ActionDialog
        label="Rename"
        icon={<PencilIcon />}
        variant="ghost"
        title="Rename category"
        submitLabel="Save"
        success="Category renamed"
        canSubmit={text.trim() !== "" && text.trim() !== name}
        onOpen={() => setText(name)}
        onSubmit={() => renameCategoryAction({ id, name: text })}
      >
        <div className="grid gap-2">
          <Label htmlFor={`rename-${id}`}>Name</Label>
          <Input id={`rename-${id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={120} required />
        </div>
      </ActionDialog>
      <ActionDialog
        label={active ? "Deactivate" : "Reactivate"}
        icon={<PowerIcon />}
        variant="ghost"
        title={active ? `Deactivate ${name}?` : `Reactivate ${name}?`}
        description={active ? "It can no longer be chosen for new accounts. Accounts that have it keep it, and its pricing history stays." : "It can be chosen for new accounts again."}
        submitLabel={active ? "Deactivate" : "Reactivate"}
        success={active ? "Category deactivated" : "Category reactivated"}
        onSubmit={() => setCategoryActiveAction({ id, active: !active })}
      />
    </>
  );
}

export interface AssignmentFacts {
  versionNo: number;
  effectiveFrom: string;
  tariffId: string | null;
  standingChargeItemId: string | null;
  meterRentItemId: string | null;
  discountItemId: string | null;
}
export interface Option {
  id: string;
  name: string;
}

const CLEAR = "__clear";

/** Points a category at a tariff, standing charge, meter rent and discount from a date (T-02, T-03). */
export function AssignTariff({
  categoryId,
  categoryName,
  history,
  tariffs,
  standing,
  discounts,
  names,
  next,
  locale,
}: {
  categoryId: string;
  categoryName: string;
  history: readonly AssignmentFacts[];
  tariffs: readonly Option[];
  standing: readonly Option[];
  discounts: readonly Option[];
  names: Record<string, string>;
  next: NextEffective;
  locale: string;
}) {
  const [choice, setChoice] = useState<AssignmentChoice>(keepAll);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const dates = history.map((h) => h.effectiveFrom);
  const preview = previewEffectiveDate({ typed: effectiveFrom, next, existing: dates, first: history.length === 0, locale });
  // What carries over is the assignment in force on the effective date, not necessarily today's.
  const base = preview.kind === "refused" ? inForceOn(history, next.today) : inForceOn(history, preview.date);
  const nameOf = (_key: AssignmentKey, id: string) => names[id] ?? "Unknown";
  const outcome = assignmentOutcome(choice, base, nameOf);
  const options: Record<AssignmentKey, readonly Option[]> = { tariffId: tariffs, standingChargeItemId: standing, meterRentItemId: standing, discountItemId: discounts };
  const select = (key: AssignmentKey) => {
    const before = base?.[key] ?? null;
    const keepLabel = `Keep ${before ? (names[before] ?? "current") : "none"}`;
    const value = choice[key] === KEEP ? KEEP : choice[key] === "" ? CLEAR : choice[key];
    return (
      <div className="grid gap-1.5" key={key}>
        <Label htmlFor={`assign-${key}`}>{assignmentKeyLabel[key]}</Label>
        <FieldSelect
          id={`assign-${key}`}
          value={value}
          onChange={(v) => setChoice({ ...choice, [key]: v === KEEP ? KEEP : v === CLEAR ? "" : v })}
          options={[{ value: KEEP, label: keepLabel }, { value: CLEAR, label: "None (clear it)" }, ...options[key].map((o) => ({ value: o.id, label: o.name }))]}
          placeholder="Choose"
        />
      </div>
    );
  };

  return (
    <ActionDialog
      label="Change pricing"
      icon={<LinkIcon />}
      title={`Pricing for ${categoryName}`}
      description="Adds an assignment from a date. History keeps every earlier one, so any past bill can say which tariff applied."
      submitLabel="Add assignment"
      success="Pricing assignment added"
      canSubmit={assignmentChanged(choice, base) && preview.kind !== "refused"}
      onOpen={() => {
        setChoice(keepAll);
        setEffectiveFrom("");
        setReason("");
      }}
      onSubmit={() => assignTariffAction({ categoryId, choice, effectiveFrom, reason })}
    >
      {ASSIGNMENT_KEYS.map(select)}
      <EffectiveDateField id={`assign-date-${categoryId}`} value={effectiveFrom} onChange={setEffectiveFrom} next={next} existing={dates} first={history.length === 0} locale={locale} />
      <ul className="grid gap-1 rounded-lg bg-muted/50 p-3 text-sm" aria-label="What this changes">
        {outcome.map((o) => (
          <li key={o.key} className="flex flex-wrap items-center gap-x-2">
            <span className="w-32 text-muted-foreground">{o.label}</span>
            {o.kind === "kept" || o.kind === "same" ? (
              <span>{o.kind === "kept" ? `kept: ${o.after}` : `unchanged: ${o.after}`}</span>
            ) : (
              <span className="flex items-center gap-1.5">
                {o.before} <ArrowRightIcon className="size-3.5" aria-hidden /> <strong className="font-medium">{o.kind === "cleared" ? "cleared" : o.after}</strong>
              </span>
            )}
          </li>
        ))}
        <li className="pt-1 text-xs text-muted-foreground">Whatever you keep stays as it is on the effective date. Choosing none clears it from then.</li>
      </ul>
      <div className="grid gap-2">
        <Label htmlFor={`assign-reason-${categoryId}`}>Reason (optional)</Label>
        <Input id={`assign-reason-${categoryId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Annual tariff review" />
      </div>
    </ActionDialog>
  );
}
