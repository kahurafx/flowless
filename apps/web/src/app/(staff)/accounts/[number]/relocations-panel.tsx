"use client";

import { SURVEY_FEASIBILITIES, type SurveyFeasibility } from "@flowless/shared-types";
import { CheckIcon, ClipboardPenIcon, RulerIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountPage, RelocationRow } from "@/data/accounts";
import { relocationStatusLabel, surveyFeasibilityLabel } from "@/lib/account-labels";
import { formatWhen } from "@/lib/dates";
import { cancelRelocationAction, completeRelocationAction, recordRelocationSurveyAction, recordRelocationWorkAction } from "../actions";

const tone = { requested: "info", surveyed: "info", completed: "success", cancelled: "outline" } as const;

/** Relocations of this account (C-09): request (from the action row), survey, record work, complete or cancel. */
export function RelocationsPanel({ page }: { page: AccountPage }) {
  if (page.relocations.length === 0) return null;
  const canChange = page.permissions.includes("accounts:change_status");
  const address = (id: string) => page.account.servicePoints.find((s) => s.id === id)?.address ?? "A service point";
  return (
    <section aria-labelledby="relocations" className="grid gap-3 rounded-xl border bg-card p-4">
      <h2 id="relocations" className="text-base font-semibold">
        Relocations
      </h2>
      <ul className="grid gap-3">
        {page.relocations.map((r) => (
          <li key={r.id} className="grid gap-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={tone[r.status]}>{relocationStatusLabel[r.status]}</Badge>
                <span className="text-sm">
                  {address(r.fromServicePointId)} <span className="text-muted-foreground">to</span> <span className="font-medium">{r.to.address}</span>
                </span>
              </div>
              <span className="text-xs text-muted-foreground">Requested {formatWhen(r.requestedAt, page.locale, page.timeZone, "date")}</span>
            </div>
            <p className="text-sm text-muted-foreground">{r.reason}</p>
            {r.survey && (
              <p className="text-sm">
                <span className="font-medium">Survey: {surveyFeasibilityLabel[r.survey.feasibility]}.</span> {r.survey.findings}
              </p>
            )}
            {(r.finalReading || r.initialReading) && (
              <p className="tabular text-sm text-muted-foreground">
                {r.finalReading && <>Final reading {r.finalReading}</>}
                {r.finalReading && r.initialReading && " · "}
                {r.initialReading && <>Initial reading {r.initialReading}</>}
              </p>
            )}
            {canChange && (r.status === "requested" || r.status === "surveyed") && (
              <div className="flex flex-wrap gap-2">
                <SurveyStep relocation={r} />
                <WorkStep relocation={r} />
                <CompleteStep relocation={r} />
                <CancelStep relocation={r} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SurveyStep({ relocation }: { relocation: RelocationRow }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [feasibility, setFeasibility] = useState<SurveyFeasibility>("feasible");
  const [findings, setFindings] = useState("");
  return (
    <ActionDialog
      label={relocation.survey ? "Re-record survey" : "Record survey"}
      icon={<RulerIcon />}
      title="Record the relocation survey"
      description="What the survey found at the new place."
      submitLabel="Record survey"
      success="Survey recorded"
      onOpen={() => setId(crypto.randomUUID())}
      canSubmit={findings.trim() !== ""}
      onSubmit={async () => ({ error: (await recordRelocationSurveyAction({ id, relocationId: relocation.id, feasibility, findings: findings.trim() })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`rs-f-${relocation.id}`}>Result</Label>
        <FieldSelect id={`rs-f-${relocation.id}`} value={feasibility} onChange={(v) => setFeasibility(v as SurveyFeasibility)} options={SURVEY_FEASIBILITIES.map((f) => ({ value: f, label: surveyFeasibilityLabel[f] }))} placeholder="Result" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`rs-t-${relocation.id}`}>Findings</Label>
        <Textarea id={`rs-t-${relocation.id}`} value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} maxLength={4000} required />
      </div>
    </ActionDialog>
  );
}

function WorkStep({ relocation }: { relocation: RelocationRow }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [finalReading, setFinal] = useState(relocation.finalReading ?? "");
  const [initialReading, setInitial] = useState(relocation.initialReading ?? "");
  return (
    <ActionDialog
      label="Record work"
      icon={<ClipboardPenIcon />}
      title="Record the readings"
      description="The final reading of the old point and the initial reading of the new one."
      submitLabel="Save readings"
      success="Readings recorded"
      onOpen={() => setId(crypto.randomUUID())}
      canSubmit={finalReading.trim() !== "" || initialReading.trim() !== ""}
      onSubmit={async () =>
        ({
          error: (
            await recordRelocationWorkAction({
              id,
              relocationId: relocation.id,
              ...(finalReading.trim() ? { finalReading: finalReading.trim() } : {}),
              ...(initialReading.trim() ? { initialReading: initialReading.trim() } : {}),
            })
          ).error,
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`rw-f-${relocation.id}`}>Final reading (old point)</Label>
          <Input id={`rw-f-${relocation.id}`} value={finalReading} onChange={(e) => setFinal(e.target.value)} inputMode="decimal" maxLength={40} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`rw-i-${relocation.id}`}>Initial reading (new point)</Label>
          <Input id={`rw-i-${relocation.id}`} value={initialReading} onChange={(e) => setInitial(e.target.value)} inputMode="decimal" maxLength={40} />
        </div>
      </div>
    </ActionDialog>
  );
}

function CompleteStep({ relocation }: { relocation: RelocationRow }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      label="Complete"
      icon={<CheckIcon />}
      variant="default"
      title="Complete the relocation"
      description="Creates the service point at the new place and decommissions the old one. The account's number and status do not change."
      submitLabel="Complete relocation"
      success="Relocation completed"
      onOpen={() => setId(crypto.randomUUID())}
      onSubmit={async () => ({ error: (await completeRelocationAction({ id, relocationId: relocation.id, ...(reason.trim() ? { reason: reason.trim() } : {}) })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`rc-${relocation.id}`}>Note (optional)</Label>
        <Textarea id={`rc-${relocation.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
      </div>
    </ActionDialog>
  );
}

function CancelStep({ relocation }: { relocation: RelocationRow }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      label="Cancel"
      icon={<XIcon />}
      variant="ghost"
      title="Cancel this relocation"
      description="Nothing moves; the account stays served where it is."
      submitLabel="Cancel relocation"
      success="Relocation cancelled"
      onOpen={() => setId(crypto.randomUUID())}
      canSubmit={reason.trim() !== ""}
      onSubmit={async () => ({ error: (await cancelRelocationAction({ id, relocationId: relocation.id, reason: reason.trim() })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`rx-${relocation.id}`}>Reason</Label>
        <Textarea id={`rx-${relocation.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}
