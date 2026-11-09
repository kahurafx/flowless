"use client";

import { CHARGE_RECURRENCES, CHARGE_TYPES, revenueKindOf, type ChargeRecurrence, type ChargeType } from "@flowless/shared-types";
import { CoinsIcon, PencilIcon, PlusIcon, PowerIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { EffectiveDateField } from "@/components/tariffs/effective-date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewEffectiveDate, type NextEffective } from "@/lib/effective-date";
import { chargeRecurrenceLabel, chargeTypeLabel, revenueKindLabel } from "@/lib/tariff-labels";
import { addAmountVersionAction, createChargeItemAction, setChargeItemActiveAction, updateChargeItemAction } from "../actions";

const codeFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 40);

export function NewChargeItem({ next, currency, locale }: { next: NextEffective; currency: string; locale: string }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [type, setType] = useState<ChargeType>("fee");
  const [recurrence, setRecurrence] = useState<ChargeRecurrence>("monthly");
  const [amount, setAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const shownCode = codeTouched ? code : codeFrom(name);
  const priced = type !== "usage" && amount.trim() !== "";
  const preview = previewEffectiveDate({ typed: effectiveFrom, next, existing: [], first: true, locale });
  return (
    <ActionDialog
      label="New item"
      icon={<PlusIcon />}
      variant="default"
      title="New charge item"
      description="The code and type are permanent. A usage item is priced by a tariff; any other type has amounts you add here."
      submitLabel="Create item"
      success="Charge item created"
      canSubmit={name.trim() !== "" && shownCode !== "" && (!priced || preview.kind !== "refused")}
      onOpen={() => {
        setName("");
        setCode("");
        setCodeTouched(false);
        setType("fee");
        setAmount("");
        setEffectiveFrom("");
      }}
      onSubmit={() => createChargeItemAction({ code: shownCode, name, type, recurrence, amount, effectiveFrom })}
    >
      <div className="grid gap-2">
        <Label htmlFor="charge-name">Name</Label>
        <Input id="charge-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Reconnection fee" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="charge-code">Code</Label>
        <Input id="charge-code" value={shownCode} onChange={(e) => (setCodeTouched(true), setCode(e.target.value))} maxLength={40} className="font-mono" placeholder="reconnection_fee" />
        <p className="text-xs text-muted-foreground">Lower-case letters, digits and underscores. Invoice templates refer to the item by this code.</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="charge-type">Type</Label>
        <FieldSelect id="charge-type" value={type} onChange={(v) => setType(v as ChargeType)} options={CHARGE_TYPES.map((t) => ({ value: t, label: chargeTypeLabel[t] }))} placeholder="Choose a type" />
        {revenueKindOf(type) !== "revenue" && <p className="text-xs text-warning">{revenueKindLabel[revenueKindOf(type)]}: the ledger does not count it as revenue.</p>}
      </div>
      {type === "recurring" && (
        <div className="grid gap-2">
          <Label htmlFor="charge-recurrence">Charged</Label>
          <FieldSelect id="charge-recurrence" value={recurrence} onChange={(v) => setRecurrence(v as ChargeRecurrence)} options={CHARGE_RECURRENCES.map((r) => ({ value: r, label: chargeRecurrenceLabel[r] }))} placeholder="Choose" />
        </div>
      )}
      {type !== "usage" && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="charge-amount">First amount ({currency}, optional)</Label>
            <Input id="charge-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1500.00" />
          </div>
          {priced && <EffectiveDateField id="charge-first-date" value={effectiveFrom} onChange={setEffectiveFrom} next={next} existing={[]} first locale={locale} />}
        </>
      )}
    </ActionDialog>
  );
}

/** A new amount from a date (T-07, T-03): never an edit. */
export function AddAmount({
  id,
  name,
  currency,
  history,
  next,
  locale,
}: {
  id: string;
  name: string;
  currency: string;
  history: readonly string[];
  next: NextEffective;
  locale: string;
}) {
  const [amount, setAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const preview = previewEffectiveDate({ typed: effectiveFrom, next, existing: history, first: history.length === 0, locale });
  return (
    <ActionDialog
      label="New amount"
      icon={<CoinsIcon />}
      variant="ghost"
      title={`New amount for ${name}`}
      description="Adds an amount from a date. The earlier amounts stay in the history."
      submitLabel="Add amount"
      success="Amount added"
      canSubmit={amount.trim() !== "" && preview.kind !== "refused"}
      onOpen={() => {
        setAmount("");
        setEffectiveFrom("");
        setReason("");
      }}
      onSubmit={() => addAmountVersionAction({ chargeItemId: id, amount, effectiveFrom, reason })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`amount-${id}`}>Amount ({currency})</Label>
        <Input id={`amount-${id}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1500.00" required />
      </div>
      <EffectiveDateField id={`amount-date-${id}`} value={effectiveFrom} onChange={setEffectiveFrom} next={next} existing={history} first={history.length === 0} locale={locale} />
      <div className="grid gap-2">
        <Label htmlFor={`amount-reason-${id}`}>Reason (optional)</Label>
        <Input id={`amount-reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Board resolution 14/2026" />
      </div>
    </ActionDialog>
  );
}

export function EditChargeItem({ id, name, type, recurrence, active }: { id: string; name: string; type: ChargeType; recurrence: ChargeRecurrence | null; active: boolean }) {
  const [text, setText] = useState(name);
  const [rec, setRec] = useState<ChargeRecurrence>(recurrence ?? "monthly");
  return (
    <>
      <ActionDialog
        label="Edit"
        icon={<PencilIcon />}
        variant="ghost"
        title={`Edit ${name}`}
        description="The code and type cannot change."
        submitLabel="Save"
        success="Charge item saved"
        canSubmit={text.trim() !== "" && (text.trim() !== name || (type === "recurring" && rec !== recurrence))}
        onOpen={() => {
          setText(name);
          setRec(recurrence ?? "monthly");
        }}
        onSubmit={() => updateChargeItemAction({ id, name: text, ...(type === "recurring" ? { recurrence: rec } : {}) })}
      >
        <div className="grid gap-2">
          <Label htmlFor={`edit-${id}`}>Name</Label>
          <Input id={`edit-${id}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={120} required />
        </div>
        {type === "recurring" && (
          <div className="grid gap-2">
            <Label htmlFor={`rec-${id}`}>Charged</Label>
            <FieldSelect id={`rec-${id}`} value={rec} onChange={(v) => setRec(v as ChargeRecurrence)} options={CHARGE_RECURRENCES.map((r) => ({ value: r, label: chargeRecurrenceLabel[r] }))} placeholder="Choose" />
          </div>
        )}
      </ActionDialog>
      <ActionDialog
        label={active ? "Deactivate" : "Reactivate"}
        icon={<PowerIcon />}
        variant="ghost"
        title={active ? `Deactivate ${name}?` : `Reactivate ${name}?`}
        description={active ? "It is taken out of use for new invoices. Its history, and invoices already issued, are untouched." : "It can be used on new invoices again."}
        submitLabel={active ? "Deactivate" : "Reactivate"}
        success={active ? "Charge item deactivated" : "Charge item reactivated"}
        onSubmit={() => setChargeItemActiveAction({ id, active: !active })}
      />
    </>
  );
}
