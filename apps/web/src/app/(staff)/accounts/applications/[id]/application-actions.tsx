"use client";

import { SURVEY_FEASIBILITIES, type SurveyFeasibility } from "@flowless/shared-types";
import { ArrowRightIcon, BanIcon, ClipboardListIcon, ExternalLinkIcon, UserCheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { surveyFeasibilityLabel } from "@/lib/account-labels";
import type { AdvanceKind, ApplicationOffers } from "@/lib/application-view";
import { advanceApplicationAction, convertApplicationAction, endApplicationAction, recordSurveyAction } from "../actions";

const ADVANCE: Record<AdvanceKind, { label: string; title: string; description: string; success: string }> = {
  submit: { label: "Submit application", title: "Submit the application", description: "The application is complete and goes forward.", success: "Application submitted" },
  invoiced: { label: "Mark invoiced", title: "Mark as invoiced", description: "The new-connection invoice is out. Billing does not exist yet, so enter the invoice's own reference.", success: "Marked invoiced" },
  paid: { label: "Mark paid", title: "Mark as paid", description: "The invoice is paid. Payments do not exist yet, so enter the payment's own reference.", success: "Marked paid" },
  installation: { label: "Start installation", title: "Start the installation", description: "The crew has begun installing the connection.", success: "Installation started" },
  ready: { label: "Mark ready", title: "Mark ready", description: "The connection is installed and ready to become an account.", success: "Marked ready" },
  convert: { label: "Open the account", title: "Turn this application into an account", description: "Opens the account and its service point from the application. The account starts new; activation follows its own gates.", success: "Account opened" },
};

/** Everything the office can do to an application now (C-05). What is offered comes from the stage machine's view of the stage; the procedures decide. */
export function ApplicationActions({ applicationId, offers, surveyJobHref }: { applicationId: string; offers: ApplicationOffers; surveyJobHref: string | null }) {
  if (!offers.advance && !offers.recordSurvey && !offers.end && !surveyJobHref) return null;
  return (
    <div className="grid gap-2">
      {offers.waiting && (
        <p role="status" className="rounded-xl bg-info/12 p-3 text-sm text-info">
          {offers.waiting}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {offers.recordSurvey && <RecordSurvey applicationId={applicationId} />}
        {surveyJobHref && (
          <Button variant="outline" render={<Link href={surveyJobHref} />}>
            <ClipboardListIcon />
            Raise survey job
            <ExternalLinkIcon className="opacity-60" />
          </Button>
        )}
        {offers.advance && <Advance applicationId={applicationId} kind={offers.advance} />}
        {offers.end && <End applicationId={applicationId} to="rejected" />}
        {offers.end && <End applicationId={applicationId} to="cancelled" />}
      </div>
    </div>
  );
}

function RecordSurvey({ applicationId }: { applicationId: string }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [feasibility, setFeasibility] = useState<SurveyFeasibility>("feasible");
  const [findings, setFindings] = useState("");
  const [materials, setMaterials] = useState("");
  return (
    <ActionDialog
      label="Record survey"
      icon={<UserCheckIcon />}
      variant="default"
      title="Record the survey result"
      description={feasibility === "feasible" ? "A feasible survey is sent for approval before the application can move on." : "A survey that finds the connection not feasible asks for no approval; reject the application or record a new survey."}
      submitLabel="Record survey"
      success="Survey recorded"
      onOpen={() => setId(crypto.randomUUID())}
      canSubmit={findings.trim() !== ""}
      onSubmit={async () => ({ error: (await recordSurveyAction({ id, applicationId, feasibility, findings: findings.trim(), materialsNote: materials })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="survey-result">Result</Label>
        <FieldSelect id="survey-result" value={feasibility} onChange={(v) => setFeasibility(v as SurveyFeasibility)} options={SURVEY_FEASIBILITIES.map((f) => ({ value: f, label: surveyFeasibilityLabel[f] }))} placeholder="Result" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="survey-findings">Findings</Label>
        <Textarea id="survey-findings" value={findings} onChange={(e) => setFindings(e.target.value)} rows={3} maxLength={4000} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="survey-materials">Materials needed (optional)</Label>
        <Textarea id="survey-materials" value={materials} onChange={(e) => setMaterials(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function Advance({ applicationId, kind }: { applicationId: string; kind: AdvanceKind }) {
  const router = useRouter();
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reference, setReference] = useState("");
  const c = ADVANCE[kind];
  const needsRef = kind === "invoiced" || kind === "paid";
  return (
    <ActionDialog
      label={c.label}
      icon={<ArrowRightIcon />}
      variant="default"
      title={c.title}
      description={c.description}
      submitLabel={c.label}
      success={c.success}
      onOpen={() => {
        setId(crypto.randomUUID());
        setReference("");
      }}
      canSubmit={!needsRef || reference.trim() !== ""}
      onSubmit={async () => {
        if (kind === "convert") {
          const result = await convertApplicationAction({ id, applicationId });
          if (result.error === null && result.data) router.push(`/accounts/${encodeURIComponent(result.data)}`);
          return { error: result.error };
        }
        const base = { id, applicationId };
        const result = await advanceApplicationAction(
          kind === "invoiced" ? { kind, ...base, invoiceRef: reference.trim() } : kind === "paid" ? { kind, ...base, paymentRef: reference.trim() } : { kind, ...base },
        );
        return { error: result.error };
      }}
    >
      {needsRef && (
        <div className="grid gap-2">
          <Label htmlFor="advance-ref">{kind === "invoiced" ? "Invoice reference" : "Payment reference"}</Label>
          <Input id="advance-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} required />
        </div>
      )}
    </ActionDialog>
  );
}

function End({ applicationId, to }: { applicationId: string; to: "rejected" | "cancelled" }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const rejecting = to === "rejected";
  return (
    <ActionDialog
      label={rejecting ? "Reject" : "Cancel application"}
      icon={rejecting ? <BanIcon /> : <XIcon />}
      variant={rejecting ? "destructive" : "ghost"}
      title={rejecting ? "Reject this application" : "Cancel this application"}
      description={rejecting ? "The office turns the request down. This is final." : "The customer no longer wants it. This is final."}
      submitLabel={rejecting ? "Reject" : "Cancel application"}
      success={rejecting ? "Application rejected" : "Application cancelled"}
      onOpen={() => setId(crypto.randomUUID())}
      canSubmit={reason.trim() !== ""}
      onSubmit={async () => ({ error: (await endApplicationAction({ id, applicationId, reason: reason.trim(), to })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`end-${to}`}>Reason</Label>
        <Textarea id={`end-${to}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}
