"use client";

import { BanIcon, FilePlus2Icon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ADJUSTMENT_REASONS, NOTE_KIND_LABEL, type RebillForm } from "@/lib/billing-view";
import { rebillAction, requestNoteAction, voidDocumentAction } from "../billing-actions";

const outcome = (r: { error: string | null }) => ({ error: r.error });

function ReasonBox({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Reason</Label>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={2000} required />
    </div>
  );
}

/** Void: reverses the invoice in the ledger; the document stays and is marked reversed. */
export function VoidDialog({ documentId, number }: { documentId: string; number: string }) {
  const [key, mint] = useMintedId();
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      label="Void"
      icon={<BanIcon />}
      variant="outline"
      title={`Void ${number}`}
      description="Posts a reversal that mirrors this document. Nothing is edited or deleted; the reversal appears on the statement. Refused if live credit or debit notes refer to it."
      submitLabel="Void document"
      success="Document voided"
      onOpen={mint}
      canSubmit={reason.trim() !== ""}
      onSubmit={async () => outcome(await voidDocumentAction({ key, documentId, reason }))}
    >
      <ReasonBox id="void-reason" value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

/** Re-bill: void and replace in one step. Until Metering (Phase 5) the reading is typed here. */
export function RebillDialog({ documentId, number, base }: { documentId: string; number: string; base: Pick<RebillForm, "accountId" | "categoryId" | "invoiceTypeId" | "periodTo"> }) {
  const [key, mint] = useMintedId();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<RebillForm["mode"]>("units");
  const [value, setValue] = useState("");
  const [baselinePeriod, setBaselinePeriod] = useState("");
  const [baselineDial, setBaselineDial] = useState("");
  return (
    <ActionDialog
      label="Re-bill"
      icon={<RefreshCwIcon />}
      variant="outline"
      title={`Re-bill ${number}`}
      description="Voids this invoice and issues a replacement for the same month, priced from the tariff in force. If the replacement cannot be priced, nothing is voided."
      submitLabel="Void and re-bill"
      success="Invoice re-billed"
      onOpen={mint}
      canSubmit={reason.trim() !== "" && (mode === "estimate" || value.trim() !== "")}
      onSubmit={async () => outcome(await rebillAction({ key, documentId, reason, form: { ...base, mode, value, baselinePeriod, baselineDial } }))}
    >
      <ReasonBox id="rebill-reason" value={reason} onChange={setReason} />
      <div className="grid gap-2">
        <Label htmlFor="rebill-mode">Corrected consumption</Label>
        <FieldSelect
          id="rebill-mode"
          value={mode}
          onChange={(v) => setMode(v as RebillForm["mode"])}
          options={[
            { value: "units", label: "Units used (m³)" },
            { value: "dial", label: "Dial reading" },
            { value: "estimate", label: "Estimate" },
          ]}
          placeholder="Choose"
        />
      </div>
      {mode !== "estimate" && (
        <div className="grid gap-2">
          <Label htmlFor="rebill-value">{mode === "units" ? "Units" : "Dial reading"}</Label>
          <Input id="rebill-value" value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" required />
        </div>
      )}
      {mode === "dial" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-2">
            <Label htmlFor="rebill-base-period">Earlier reading month</Label>
            <Input id="rebill-base-period" value={baselinePeriod} onChange={(e) => setBaselinePeriod(e.target.value)} placeholder="2026-02" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rebill-base-dial">Earlier dial</Label>
            <Input id="rebill-base-dial" value={baselineDial} onChange={(e) => setBaselineDial(e.target.value)} inputMode="numeric" />
          </div>
        </div>
      )}
    </ActionDialog>
  );
}

/** Asks for approval of a credit or debit note (K-05); the note is issued once someone with billing:approve agrees. */
export function RequestNoteDialog({ accountId, currency, relatedDocumentId }: { accountId: string; currency: string; relatedDocumentId?: string }) {
  const [id, mint] = useMintedId();
  const [kind, setKind] = useState<"credit_note" | "debit_note">("credit_note");
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState<string>(ADJUSTMENT_REASONS[0].code);
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Request credit or debit note"
      icon={<FilePlus2Icon />}
      variant="outline"
      title="Request a credit or debit note"
      description="A note needs approval from someone else (Approvals) before it is issued. This asks for it; nothing is posted yet."
      submitLabel="Ask for approval"
      success="Note requested"
      onOpen={mint}
      canSubmit={amount.trim() !== "" && note.trim() !== ""}
      onSubmit={async () => outcome(await requestNoteAction({ id, accountId, kind, amountText: amount, reasonCode: code, note, ...(relatedDocumentId ? { relatedDocumentId } : {}) }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="note-kind">Kind</Label>
        <FieldSelect id="note-kind" value={kind} onChange={(v) => setKind(v as typeof kind)} options={Object.entries(NOTE_KIND_LABEL).map(([value, label]) => ({ value, label }))} placeholder="Choose" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="note-amount">Amount ({currency})</Label>
        <Input id="note-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="1250.00" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="note-reason">Reason</Label>
        <FieldSelect id="note-reason" value={code} onChange={setCode} options={ADJUSTMENT_REASONS.map((r) => ({ value: r.code, label: r.label }))} placeholder="Choose a reason" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="note-note">Why</Label>
        <Textarea id="note-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required />
      </div>
    </ActionDialog>
  );
}
