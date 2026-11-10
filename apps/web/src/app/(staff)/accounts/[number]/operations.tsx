"use client";

import { PauseCircleIcon, PlayCircleIcon, ScaleIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountOperations } from "@/data/billing-ops";
import { DISCONNECT_REASONS } from "@/lib/account-labels";
import { asMoney } from "@/lib/billing-view";
import { disconnectAction, postCorrectionAction, previewCorrectionAction, reconnectAction, requestCorrectionAction } from "../operations-actions";

const OTHER = "__other";

/**
 * B-12: disconnect with the final reading and the final bill in one step. A metered account must
 * give its final dial; the month is billed in full plus the turn-off fee, once. If anything is
 * refused (a held bill, a reading the checks block) nothing is done.
 */
export function DisconnectWithBill({ accountId, ops }: { accountId: string; ops: AccountOperations }) {
  const [id, mint] = useMintedId();
  const [dial, setDial] = useState("");
  const [rollover, setRollover] = useState(false);
  const [choice, setChoice] = useState<string>(DISCONNECT_REASONS[0]);
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const [fee, setFee] = useState("");
  const reason = choice === OTHER ? other.trim() : choice;
  const digits = ops.meter?.dialDigits ?? 12;
  return (
    <ActionDialog
      label="Disconnect service"
      icon={<PauseCircleIcon />}
      title="Disconnect and issue the final bill"
      description={
        ops.meter
          ? `Meter ${ops.meter.serial} is installed, so the final dial is required. The final reading is recorded and the month's consumption is billed to it, with the month's standing charge in full and the turn-off fee, once. The service is then disconnected.`
          : ops.meteringLicensed
            ? "No meter is installed on this account's service point. Give the final dial; with no earlier reading it only sets the baseline and no bill is made."
            : "Metering is not licensed. Give the final dial; the bill is made from it and the account's earlier readings, and with none the dial only sets the baseline."
      }
      submitLabel="Disconnect and bill"
      success="Disconnected, final bill issued"
      variant="outline"
      onOpen={() => {
        mint();
        setDial("");
        setRollover(false);
      }}
      canSubmit={dial.trim() !== "" && reason !== ""}
      onSubmit={async () => ({ error: (await disconnectAction({ id, accountId, dial, digits, rollover, reason, note, feeItemId: fee })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="dc-dial">Final dial{ops.meter ? ` (${ops.meter.dialDigits} digits)` : ""}</Label>
        <Input id="dc-dial" value={dial} onChange={(e) => setDial(e.target.value)} inputMode="numeric" maxLength={digits} className="w-40 tabular" required />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={rollover} onCheckedChange={(v) => setRollover(v === true)} />
          The dial went round since the last reading
        </label>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="dc-reason">Reason</Label>
        <FieldSelect id="dc-reason" value={choice} onChange={setChoice} options={[...DISCONNECT_REASONS.map((r) => ({ value: r, label: r })), { value: OTHER, label: "Other" }]} placeholder="Choose a reason" />
        {choice === OTHER && <Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={500} aria-label="Other reason" placeholder="Say why" required />}
      </div>
      {ops.feeItems && ops.feeItems.length > 0 && (
        <div className="grid gap-2">
          <Label htmlFor="dc-fee">Turn-off fee</Label>
          <FieldSelect id="dc-fee" value={fee} onChange={setFee} options={ops.feeItems.map((i) => ({ value: i.id, label: i.name }))} placeholder="No fee" none="No fee" />
          <p className="text-xs text-muted-foreground">The amount in force today, cited on the bill&apos;s fee line.</p>
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="dc-note">Note (optional)</Label>
        <Textarea id="dc-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

/** B-12: reconnect from the final bill's recorded dial. A dial that moved still reconnects but opens an illegal-consumption case. */
export function ReconnectWithCheck({ accountId, ops }: { accountId: string; ops: AccountOperations }) {
  const [id, mint] = useMintedId();
  const [dial, setDial] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const digits = ops.meter?.dialDigits ?? 12;
  return (
    <ActionDialog
      label="Reconnect and check dial"
      icon={<PlayCircleIcon />}
      title="Reconnect against the final reading"
      description="Give the dial found now. If it still equals the final reading the service is reconnected; if it moved, the service is still reconnected but a revenue case for illegal consumption is opened, and nothing is billed for the moved units. Billing restarts from the final bill."
      submitLabel="Reconnect"
      success="Service reconnected"
      variant="outline"
      onOpen={() => {
        mint();
        setDial("");
      }}
      canSubmit={dial.trim() !== "" && reason.trim() !== ""}
      onSubmit={async () => ({ error: (await reconnectAction({ id, accountId, dial, digits, reason, note })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="rc-dial">Dial found{ops.meter ? ` (${ops.meter.dialDigits} digits)` : ""}</Label>
        <Input id="rc-dial" value={dial} onChange={(e) => setDial(e.target.value)} inputMode="numeric" maxLength={digits} className="w-40 tabular" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="rc-reason">Reason</Label>
        <Textarea id="rc-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="rc-note">Note (optional)</Label>
        <Textarea id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

type Preview = Extract<Awaited<ReturnType<typeof previewCorrectionAction>>, { error: null }>["data"];

const CORRECTION_REASONS = [
  { value: "LATE_READING", label: "Late reading" },
  { value: "READING_CORRECTED", label: "Reading corrected" },
  { value: "OTHER", label: "Other (explain in the note)" },
];

/**
 * B-13, B-14: a late or corrected reading for a billed period posts today as credit and debit
 * notes. Preview first (nothing is written): it shows the documents and which route they take.
 * Inside the grace window a billing runner posts; after it an approved request is needed; a large
 * deviation needs evidence either way.
 */
export function CorrectionDialog({ accountId, ops }: { accountId: string; ops: AccountOperations }) {
  const [id, mint] = useMintedId();
  const [period, setPeriod] = useState(ops.periods[0] ?? "");
  const [evidence, setEvidence] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState("");
  const [reasonCode, setReasonCode] = useState("READING_CORRECTED");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const approved = ops.corrections.filter((c) => c.status === "approved" && c.period === period);
  const decision = preview?.decision ?? null;
  const posting = decision?.route === "clerk" || approvalId !== "";
  const runPreview = () =>
    start(async () => {
      const result = await previewCorrectionAction({ accountId, period, evidenceNote: evidence });
      if (result.error !== null) {
        setProblem(result.error);
        setPreview(null);
      } else {
        setProblem(null);
        setPreview(result.data);
      }
    });
  const ready = preview !== null && preview.documents.length > 0 && decision !== null && !decision.needsEvidence && (posting || note.trim() !== "");
  return (
    <ActionDialog
      label="Correct a billed period"
      icon={<ScaleIcon />}
      title="Correct a billed period"
      description="Re-prices the period from the corrected readings and posts the difference today as credit or debit notes citing the original invoice. The original is never changed."
      submitLabel={posting ? "Post correction" : "Request approval"}
      success={posting ? "Correction posted" : "Approval requested"}
      variant="outline"
      onOpen={() => {
        mint();
        setPreview(null);
        setProblem(null);
        setApprovalId("");
      }}
      canSubmit={ready}
      onSubmit={async () => {
        if (posting) return { error: (await postCorrectionAction({ id, accountId, period, evidenceNote: evidence, approvalId, note })).error };
        return { error: (await requestCorrectionAction({ accountId, period, reasonCode, note, evidenceNote: evidence })).error };
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="corr-period">Period (year-month)</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="corr-period"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPreview(null);
            }}
            placeholder="2026-05"
            className="w-32"
            list="corr-periods"
          />
          <datalist id="corr-periods">
            {ops.periods.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Button type="button" variant="outline" onClick={runPreview} disabled={pending || period.trim() === ""}>
            Preview
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="corr-evidence">Evidence note (needed for a large correction)</Label>
        <Textarea
          id="corr-evidence"
          value={evidence}
          onChange={(e) => {
            setEvidence(e.target.value);
            setPreview(null);
          }}
          rows={2}
          maxLength={2000}
          placeholder="What the corrected reading is based on"
        />
      </div>
      {problem && (
        <p role="status" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {preview && (
        <div className="grid gap-3 rounded-lg border p-3 text-sm" aria-live="polite">
          {preview.documents.length === 0 ? (
            <p>Nothing to correct for that period: the readings price to what was billed.</p>
          ) : (
            <ul className="grid gap-2">
              {preview.documents.map((d) => (
                <li key={d.period}>
                  <span className="font-medium">
                    {d.period}: {d.kind === "credit_note" ? "credit note" : "debit note"}
                  </span>{" "}
                  <MoneyText value={asMoney(d.total < 0n ? -d.total : d.total, ops.currency)} locale={ops.locale} tone="plain" />
                  {d.originalNumber && <span className="text-muted-foreground"> against {d.originalNumber}</span>}
                  <span className="block text-xs text-muted-foreground">{d.text}</span>
                </li>
              ))}
            </ul>
          )}
          {preview.problems.length > 0 && (
            <ul className="text-xs text-warning">
              {preview.problems.map((p) => (
                <li key={p.period}>
                  {p.period} could not be re-priced: {p.message}
                </li>
              ))}
            </ul>
          )}
          {decision && (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={decision.route === "clerk" ? "success" : "warning"}>{decision.route === "clerk" ? "You can post this" : "Needs an approved request"}</Badge>
                {decision.large && <Badge variant="destructive">Large deviation</Badge>}
              </div>
              <ul className="text-xs text-muted-foreground">
                {decision.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {decision.needsEvidence && <p className="text-xs text-destructive">Add an evidence note of at least five characters, then preview again.</p>}
            </div>
          )}
        </div>
      )}
      {preview && decision?.route === "approval" && preview.documents.length > 0 && (
        <>
          {approved.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="corr-approval">Approved request</Label>
              <FieldSelect
                id="corr-approval"
                value={approvalId}
                onChange={setApprovalId}
                options={approved.map((a) => ({ value: a.id, label: `Approved request for ${a.period}` }))}
                placeholder="Choose an approved request"
                none="Ask for approval instead"
              />
            </div>
          )}
          {!posting && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="corr-reason">Reason</Label>
                <FieldSelect id="corr-reason" value={reasonCode} onChange={setReasonCode} options={CORRECTION_REASONS} placeholder="Choose a reason" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="corr-note">Why (for the approver)</Label>
                <Textarea id="corr-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} required />
              </div>
            </>
          )}
        </>
      )}
    </ActionDialog>
  );
}
