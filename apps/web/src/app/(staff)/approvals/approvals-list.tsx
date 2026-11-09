"use client";

import { money } from "@flowless/shared-types";
import { CheckIcon, UndoIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ApprovalRow, ApprovalView } from "@/data/approvals";
import { formatWhen } from "@/lib/dates";
import { approveAction, rejectAction, withdrawAction } from "./actions";

const statusTone = { pending: "warning", approved: "success", rejected: "destructive", cancelled: "outline" } as const;
const statusText = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Withdrawn" } as const;

const EMPTY: Record<ApprovalView, string> = {
  to_decide: "Nothing is waiting for your decision.",
  open: "No open requests that involve you.",
  closed: "Nothing has been decided yet.",
};

export function ApprovalsList({ rows, view, currency, locale, timeZone }: { rows: ApprovalRow[]; view: ApprovalView; currency: string; locale: string; timeZone: string }) {
  if (rows.length === 0) return <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{EMPTY[view]}</p>;
  return (
    <ul className="grid gap-3">
      {rows.map((r) => (
        <li key={r.id} className="grid gap-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <p className="text-xs text-muted-foreground">{r.kindLabel}</p>
              <p className="font-medium">{r.title}</p>
              <p className="text-sm text-muted-foreground">
                Asked by {r.requester} on {formatWhen(r.requestedAt, locale, timeZone)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {r.amount !== null && <MoneyText value={money(r.amount, currency)} locale={locale} className="font-semibold" />}
              <Badge variant={statusTone[r.status]}>{statusText[r.status]}</Badge>
              {r.overdue && <Badge variant="destructive">Overdue</Badge>}
              {r.escalated && <Badge variant="warning">Escalated</Badge>}
            </div>
          </div>
          {(r.reasonLabel || r.note) && (
            <p className="text-sm">
              {r.reasonLabel && <span className="font-medium">{r.reasonLabel}. </span>}
              {r.note}
            </p>
          )}
          {r.status === "pending" && r.waitingFor && (
            <p className="text-xs text-muted-foreground">
              Waiting for {r.waitingFor}
              {r.levels.length > 1 ? ` (level ${r.level + 1} of ${r.levels.length})` : ""}
              {r.dueAt ? `, due ${formatWhen(r.dueAt, locale, timeZone)}` : ""}
            </p>
          )}
          {(r.canDecide || r.canCancel) && (
            <div className="flex flex-wrap gap-2">
              {r.canDecide && <Decide id={r.id} approve />}
              {r.canDecide && <Decide id={r.id} approve={false} />}
              {r.canCancel && <Withdraw id={r.id} />}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Decide({ id, approve }: { id: string; approve: boolean }) {
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label={approve ? "Approve" : "Reject"}
      icon={approve ? <CheckIcon /> : <XIcon />}
      variant={approve ? "default" : "outline"}
      title={approve ? "Approve this request" : "Reject this request"}
      description={approve ? "Your decision is recorded against your name." : "The requester is told why."}
      submitLabel={approve ? "Approve" : "Reject"}
      success={approve ? "Approved" : "Rejected"}
      onOpen={() => setNote("")}
      canSubmit={approve || note.trim() !== ""}
      onSubmit={async () => ({ error: (approve ? await approveAction(id, note) : await rejectAction(id, note.trim())).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`decide-${id}-${approve ? "a" : "r"}`}>{approve ? "Note (optional)" : "Why"}</Label>
        <Textarea id={`decide-${id}-${approve ? "a" : "r"}`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required={!approve} />
      </div>
    </ActionDialog>
  );
}

function Withdraw({ id }: { id: string }) {
  return (
    <ActionDialog
      label="Withdraw"
      icon={<UndoIcon />}
      variant="ghost"
      title="Withdraw this request"
      description="The request is closed without a decision."
      submitLabel="Withdraw"
      success="Request withdrawn"
      onSubmit={async () => ({ error: (await withdrawAction(id)).error })}
    />
  );
}
