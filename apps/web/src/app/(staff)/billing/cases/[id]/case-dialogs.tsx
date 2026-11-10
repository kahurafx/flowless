"use client";

import { FilePlusIcon, GavelIcon, HandCoinsIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { amountText } from "@/lib/money-input";
import { CASE_DECISIONS, CASE_DECISION_LABELS, backBillLines, emptyBackBillRow, type BackBillRow } from "@/lib/case-view";
import { addEvidenceAction, requestBackBillingAction, resolveCaseAction } from "../actions";

export function EvidenceDialog({ caseId }: { caseId: string }) {
  const [id, mint] = useMintedId();
  const [detail, setDetail] = useState("");
  return (
    <ActionDialog
      label="Add evidence"
      icon={<FilePlusIcon />}
      title="Add evidence"
      description="Evidence is added to the log and never edited. Describe what was seen, by whom and when."
      submitLabel="Add evidence"
      success="Evidence added"
      onOpen={() => {
        mint();
        setDetail("");
      }}
      canSubmit={detail.trim() !== ""}
      onSubmit={async () => ({ error: (await addEvidenceAction({ id, caseId, detail })).error })}
    >
      <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={4} maxLength={2000} aria-label="Evidence" required />
    </ActionDialog>
  );
}

/** Asks for the approval a back-billing needs (`billing.revenue_protection`). The amount must be exactly what the lines will total. */
export function RequestBackBillingDialog({ caseId, currency }: { caseId: string; currency: string }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Request back-billing approval"
      icon={<HandCoinsIcon />}
      title="Request approval to back-bill"
      description={`The approver decides on this amount, and the lines you resolve the case with must total exactly the same (${currency}).`}
      submitLabel="Request approval"
      success="Approval requested"
      onOpen={() => {
        setAmount("");
        setNote("");
      }}
      canSubmit={amount.trim() !== "" && note.trim() !== ""}
      onSubmit={async () => ({ error: (await requestBackBillingAction({ caseId, amountText: amount, note })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="bb-amount">Amount to back-bill</Label>
        <Input id="bb-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-44" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="bb-note">Why (for the approver)</Label>
        <Textarea id="bb-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required />
      </div>
    </ActionDialog>
  );
}

/** Resolves the case with one decision. A back-billing posts a debit note from the lines, citing the approved request where the setting requires one. */
export function ResolveDialog({
  caseId,
  currency,
  invoiceTypes,
  approvals,
  requiresApproval,
}: {
  caseId: string;
  currency: string;
  invoiceTypes: { id: string; name: string }[] | null;
  approvals: { id: string; status: string }[];
  requiresApproval: boolean | null;
}) {
  const [id, mint] = useMintedId();
  const [decision, setDecision] = useState("");
  const [note, setNote] = useState("");
  const [typeId, setTypeId] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [lines, setLines] = useState<BackBillRow[]>([emptyBackBillRow]);
  const back = decision === "back_billed";
  const approved = approvals.filter((a) => a.status === "approved");
  const total = backBillLines(lines, currency);
  const set = (i: number, patch: Partial<BackBillRow>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <ActionDialog
      label="Resolve"
      icon={<GavelIcon />}
      variant="default"
      title="Resolve this case"
      description="A case ends with one decision. This cannot be undone; the log stays."
      submitLabel="Resolve case"
      success="Case resolved"
      onOpen={() => {
        mint();
        setLines([emptyBackBillRow]);
      }}
      canSubmit={decision !== "" && note.trim() !== ""}
      onSubmit={async () => ({ error: (await resolveCaseAction({ id, caseId, decision, note, invoiceTypeId: typeId, approvalId, lines })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="res-decision">Decision</Label>
        <FieldSelect id="res-decision" value={decision} onChange={setDecision} options={CASE_DECISIONS.map((d) => ({ value: d, label: CASE_DECISION_LABELS[d] }))} placeholder="Choose a decision" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="res-note">Why</Label>
        <Textarea id="res-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} required />
      </div>
      {back && (
        <div className="grid gap-3 rounded-lg border p-3">
          {invoiceTypes === null ? (
            <p className="text-sm text-muted-foreground">Back-billing posts under an invoice type from Tariffs, which you cannot read here.</p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="res-type">Invoice type</Label>
              <FieldSelect id="res-type" value={typeId} onChange={setTypeId} options={invoiceTypes.map((t) => ({ value: t.id, label: t.name }))} placeholder="Choose an invoice type" />
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 border-t pt-3 first:border-0 first:pt-0">
              <div className="flex items-center gap-2">
                <Input value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="What it is for" aria-label={`Line ${i + 1} description`} maxLength={300} />
                {lines.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    <Trash2Icon />
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder={`Amount (${currency})`} aria-label={`Line ${i + 1} amount`} inputMode="decimal" className="w-36" />
                <Input type="date" value={l.serviceFrom} onChange={(e) => set(i, { serviceFrom: e.target.value })} aria-label={`Line ${i + 1} service from`} className="w-auto" />
                <Input type="date" value={l.serviceTo} onChange={(e) => set(i, { serviceTo: e.target.value })} aria-label={`Line ${i + 1} service to`} className="w-auto" />
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button type="button" variant="outline" onClick={() => setLines([...lines, emptyBackBillRow])}>
              <PlusIcon />
              Add a line
            </Button>
            {total.ok && <span className="text-sm tabular text-muted-foreground">Total {amountText(total.total, currency)}</span>}
          </div>
          {requiresApproval !== false && (
            <div className="grid gap-2">
              <Label htmlFor="res-approval">Approved request</Label>
              <FieldSelect id="res-approval" value={approvalId} onChange={setApprovalId} options={approved.map((a, i) => ({ value: a.id, label: `Approved request ${i + 1}` }))} placeholder="Choose an approved request" none="None" />
              {approved.length === 0 && <p className="text-xs text-muted-foreground">Back-billing normally needs an approved request. Ask for one from the case page first.</p>}
            </div>
          )}
        </div>
      )}
    </ActionDialog>
  );
}
