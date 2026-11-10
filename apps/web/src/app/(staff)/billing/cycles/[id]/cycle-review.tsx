"use client";

import { CheckCheckIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { asMoney } from "@/lib/billing-view";
import { bulkApproveAction, decideBillAction } from "../actions";

export interface ReviewRow {
  accountId: string;
  label: string;
  number: string | null;
  bucket: "clean" | "attention" | "high";
  amount: bigint | null;
  flagged: boolean;
  review: "approve" | "hold" | null;
  documentId: string | null;
}

const BUCKET = {
  clean: { label: "Clean", tone: "secondary" },
  attention: { label: "Needs a look", tone: "warning" },
  high: { label: "Large: approver only", tone: "destructive" },
} as const;

function Decide({ cycleId, row, canApprove }: { cycleId: string; row: ReviewRow; canApprove: boolean }) {
  const [decision, setDecision] = useState<"approve" | "hold">("approve");
  const [reason, setReason] = useState("");
  const blocked = row.bucket === "high" && !canApprove;
  return (
    <ActionDialog
      label="Decide"
      variant="outline"
      title={`Decide the bill for ${row.label}`}
      description={blocked ? "A bill this large is approved only by a member who may approve (billing:approve). You can still hold it." : "Approve the bill for issue, or hold it with a reason."}
      submitLabel={decision === "approve" ? "Approve" : "Hold"}
      success={decision === "approve" ? "Bill approved" : "Bill held"}
      onOpen={() => {
        setDecision(blocked ? "hold" : "approve");
        setReason("");
      }}
      canSubmit={decision === "approve" ? !blocked : reason.trim() !== ""}
      onSubmit={async () => ({ error: (await decideBillAction({ cycleId, accountId: row.accountId, decision, basis: row.review === null && row.bucket === "clean" ? "sample" : "individual", reason })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="decide-decision">Decision</Label>
        <FieldSelect
          id="decide-decision"
          value={decision}
          onChange={(v) => setDecision(v === "hold" ? "hold" : "approve")}
          options={[
            { value: "approve", label: "Approve" },
            { value: "hold", label: "Hold" },
          ]}
          placeholder="Choose"
        />
      </div>
      {decision === "hold" && (
        <div className="grid gap-2">
          <Label htmlFor="decide-reason">Reason</Label>
          <Textarea id="decide-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} required />
        </div>
      )}
    </ActionDialog>
  );
}

/**
 * Review by exception (B-16): bulk approval takes the clean bills under the threshold, except a
 * sample that stays for a person; the queue lists what is left, flagged and large first.
 */
export function CycleReview({
  cycleId,
  state,
  rows,
  approved,
  held,
  locale,
  currency,
  canRun,
  canApprove,
}: {
  cycleId: string;
  state: string;
  rows: ReviewRow[];
  approved: number;
  held: number;
  locale: string;
  currency: string;
  canRun: boolean;
  canApprove: boolean;
}) {
  const [pending, start] = useTransition();
  const inReview = state === "review";
  return (
    <section aria-labelledby="review-title" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="review-title" className="font-semibold">
          Bill review
        </h2>
        <Badge variant="success">{approved} approved</Badge>
        {held > 0 && <Badge variant="warning">{held} held</Badge>}
        <Badge variant="outline">{rows.length} waiting</Badge>
        {canRun && inReview && (
          <Button
            className="ml-auto"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await bulkApproveAction({ cycleId });
                if (result.error !== null) toast.error(result.error);
                else toast.success(`${result.data.approved} approved; ${result.data.sample.length} kept for a spot check`);
              })
            }
          >
            <CheckCheckIcon />
            Bulk approve clean bills
          </Button>
        )}
      </div>
      <p className="mt-1 mb-3 max-w-prose text-sm text-muted-foreground">
        {inReview ? "The cycle cannot leave review while a bill has no approval; a held bill counts as not approved." : "Bills are decided while the cycle is in the review state."}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Why it waits</TableHead>
              <TableHead className="text-right">Bill</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                  Nothing waits for a decision.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.accountId}>
                  <TableCell>{r.number ? <Link href={`/accounts/${encodeURIComponent(r.number)}`} className="text-primary hover:underline">{r.label}</Link> : r.label}</TableCell>
                  <TableCell>
                    <Badge variant={BUCKET[r.bucket].tone}>{BUCKET[r.bucket].label}</Badge>
                    {r.flagged && <Badge variant="warning" className="ml-1.5">Flagged</Badge>}
                  </TableCell>
                  <TableCell className="text-right">{r.amount !== null ? <MoneyText value={asMoney(r.amount, currency)} locale={locale} /> : "-"}</TableCell>
                  <TableCell>{r.review === "hold" ? <Badge variant="warning">Held</Badge> : <span className="text-muted-foreground">Pending</span>}</TableCell>
                  <TableCell>{canRun && inReview && <Decide cycleId={cycleId} row={r} canApprove={canApprove} />}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
