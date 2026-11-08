"use client";

import { WORK_ORDER_OUTCOMES, WORK_PRIORITIES, type WorkOrderOutcome, type WorkPriority } from "@flowless/shared-types";
import { BanIcon, CalendarClockIcon, CheckIcon, FlagIcon, MapPinnedIcon, PauseIcon, PlayIcon, SendIcon, UserRoundPlusIcon, Undo2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ActionDialog, settled } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { outcomeLabel, priorityLabel } from "@/components/work-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { JobPage } from "@/data/work-orders";
import { formatPosition, usePosition } from "@/lib/use-position";
import { assignJob, cancelJob, finalizeJob, openJobBranch, reviewJob, scheduleJob, transitionJob } from "../actions";
import { captureValue, CaptureForm, type CaptureSchema } from "./capture-form";

/** `datetime-local` wants local wall time without a zone. */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function JobActions({ page }: { page: JobPage }) {
  const { job, kind, can } = page;
  const router = useRouter();
  const [opening, setOpening] = useState(false);

  const openBranch = async () => {
    setOpening(true);
    const result = await openJobBranch(job.id);
    setOpening(false);
    if (result.error !== null) toast.error(result.error);
    else router.push(`/map?branch=${encodeURIComponent(result.data.branch)}&job=${job.id}`);
  };

  return (
    <div className="flex flex-wrap gap-2">
      {can.act && job.status === "blocked" && <Resume page={page} />}
      {can.act && job.status !== "blocked" && <Hold page={page} />}
      {can.act && <Finish page={page} schema={kind?.captureSchema as CaptureSchema | null} />}
      {can.review && <Review page={page} />}
      {can.openBranch && (
        <Button variant="outline" onClick={openBranch} disabled={opening}>
          <MapPinnedIcon />
          {job.branch ? "Edit on the map" : "Start editing the network"}
        </Button>
      )}
      {!can.openBranch && job.branch && can.seeMap && (
        <Button variant="outline" render={<a href={`/map?branch=${encodeURIComponent(job.branch)}&job=${job.id}`} />}>
          <MapPinnedIcon />
          View branch on the map
        </Button>
      )}
      {can.assign && <Assign page={page} />}
      {can.schedule && <Schedule page={page} />}
      {can.finalize && <Finalize page={page} />}
      {can.cancel && <Cancel page={page} />}
    </div>
  );
}

function Resume({ page }: { page: JobPage }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = settled(await transitionJob({ eventId: crypto.randomUUID(), workOrderId: page.job.id, action: { type: "resume" } }));
        setPending(false);
        if (result.error) toast.error(result.error);
        else toast.success("Work resumed");
      }}
    >
      <PlayIcon />
      Resume
    </Button>
  );
}

const HOLD_REASONS = ["Waiting for materials", "Waiting for access", "Waiting for a permit", "Unsafe to continue", "Other"];

function Hold({ page }: { page: JobPage }) {
  const [reason, setReason] = useState(HOLD_REASONS[0]!);
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Put on hold"
      icon={<PauseIcon />}
      title="Put this job on hold"
      description="It stays yours. Resume it when the blocker is gone."
      submitLabel="Put on hold"
      success="Job on hold"
      canSubmit={reason !== ""}
      onSubmit={async () => settled(await transitionJob({ eventId: crypto.randomUUID(), workOrderId: page.job.id, action: { type: "hold", reason, note } }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="hold-reason">Why</Label>
        <FieldSelect id="hold-reason" value={reason} onChange={setReason} options={HOLD_REASONS.map((r) => ({ value: r, label: r }))} placeholder="Choose a reason" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="hold-note">Note (optional)</Label>
        <Textarea id="hold-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function Finish({ page, schema }: { page: JobPage; schema: CaptureSchema | null }) {
  const { job, kind } = page;
  const review = job.review;
  const [route, setRoute] = useState<"complete" | "submit">(review === "required" ? "submit" : "complete");
  const [outcome, setOutcome] = useState<WorkOrderOutcome>("done");
  const [note, setNote] = useState("");
  const [capture, setCapture] = useState<Record<string, string>>({});
  const { position, status, request } = usePosition();
  const needPhotos = kind?.evidence.photos ?? 0;
  const needGps = kind?.evidence.gps ?? false;
  const missingPhotos = Math.max(0, needPhotos - job.photoCount);
  const submitting = route === "submit";

  return (
    <ActionDialog
      label={review === "required" ? "Submit for review" : "Finish job"}
      icon={review === "required" ? <SendIcon /> : <CheckIcon />}
      variant="default"
      title={submitting ? "Submit for review" : "Finish this job"}
      description={
        submitting ? "A supervisor will check it. You can't approve your own work." : "The job closes and its completion is announced to the rest of the system."
      }
      submitLabel={submitting ? "Submit" : "Finish"}
      success={submitting ? "Sent for review" : "Job completed"}
      onOpen={() => {
        if (needGps || status === "idle") request();
      }}
      canSubmit={!needGps || position !== null || status === "denied"}
      onSubmit={async () =>
        settled(
          await transitionJob({
            eventId: crypto.randomUUID(),
            workOrderId: job.id,
            ...(position ? { position: { latitude: position.latitude, longitude: position.longitude } } : {}),
            action: { type: route, outcome, note, ...(schema ? { capture: captureValue(schema, capture) } : {}) },
          }),
        )
      }
    >
      {review === "optional" && (
        <div className="flex gap-2" role="radiogroup" aria-label="How to finish">
          <Button type="button" variant={route === "complete" ? "default" : "outline"} onClick={() => setRoute("complete")} role="radio" aria-checked={route === "complete"}>
            Close it
          </Button>
          <Button type="button" variant={route === "submit" ? "default" : "outline"} onClick={() => setRoute("submit")} role="radio" aria-checked={route === "submit"}>
            Send for review
          </Button>
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="finish-outcome">Result</Label>
        <FieldSelect
          id="finish-outcome"
          value={outcome}
          onChange={(v) => setOutcome(v as WorkOrderOutcome)}
          options={WORK_ORDER_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel[o] }))}
          placeholder="Choose a result"
        />
      </div>
      {schema && <CaptureForm schema={schema} value={capture} onChange={setCapture} />}
      <div className="grid gap-2">
        <Label htmlFor="finish-note">Note (optional)</Label>
        <Textarea id="finish-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
      {(needPhotos > 0 || needGps) && (
        <ul className="grid gap-1 rounded-lg bg-muted p-3 text-sm" aria-label="Evidence this kind needs">
          {needPhotos > 0 && (
            <li>
              {missingPhotos === 0 ? "Photos: attached." : `Photos: ${missingPhotos} more needed. Add them under Photos first.`}
            </li>
          )}
          {needGps && (
            <li>
              Position:{" "}
              {position ? `${formatPosition(position)} (within ${Math.round(position.accuracyM)} m)` : status === "locating" ? "finding you..." : "not available. Allow location access in your browser."}
            </li>
          )}
        </ul>
      )}
    </ActionDialog>
  );
}

function Review({ page }: { page: JobPage }) {
  const [decision, setDecision] = useState<"approve" | "return">("approve");
  const [note, setNote] = useState("");
  const approve = decision === "approve";
  return (
    <ActionDialog
      label="Review"
      icon={<FlagIcon />}
      variant="default"
      title="Review this job"
      description={page.job.submission ? `${outcomeLabel[page.job.submission.outcome]}. ${page.job.submission.note}` : undefined}
      submitLabel={approve ? "Approve" : "Return for fixes"}
      success={approve ? "Approved" : "Returned"}
      canSubmit={approve || note.trim() !== ""}
      onSubmit={async () => settled(await reviewJob({ eventId: crypto.randomUUID(), workOrderId: page.job.id, decision, note }))}
    >
      <div className="flex gap-2" role="radiogroup" aria-label="Decision">
        <Button type="button" variant={approve ? "default" : "outline"} onClick={() => setDecision("approve")} role="radio" aria-checked={approve}>
          <CheckIcon />
          Approve
        </Button>
        <Button type="button" variant={!approve ? "default" : "outline"} onClick={() => setDecision("return")} role="radio" aria-checked={!approve}>
          <Undo2Icon />
          Return
        </Button>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="review-note">{approve ? "Note (optional)" : "What needs fixing"}</Label>
        <Textarea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required={!approve} />
      </div>
      <p className="text-xs text-muted-foreground">Approving closes the job. It does not post any network edits: that is done on Pending changes.</p>
    </ActionDialog>
  );
}

function Assign({ page }: { page: JobPage }) {
  const { job, people, crews, level } = page;
  const [assigneeId, setAssigneeId] = useState(job.assignedToUserId ?? "");
  const [crewId, setCrewId] = useState(job.crewId ?? "");
  return (
    <ActionDialog
      label="Assign"
      icon={<UserRoundPlusIcon />}
      title="Assign this job"
      submitLabel="Assign"
      success="Assignment saved"
      onSubmit={async () => assignJob(job.id, assigneeId || null, level === "full" ? crewId || null : undefined)}
    >
      <div className="grid gap-2">
        <Label htmlFor="assign-person">Person</Label>
        <FieldSelect id="assign-person" value={assigneeId} onChange={setAssigneeId} options={people.map((p) => ({ value: p.id, label: p.name }))} placeholder="Unassigned" none="Unassigned" />
      </div>
      {level === "full" && crews.length > 0 && (
        <div className="grid gap-2">
          <Label htmlFor="assign-crew">Crew</Label>
          <FieldSelect id="assign-crew" value={crewId} onChange={setCrewId} options={crews.map((c) => ({ value: c.id, label: c.name }))} placeholder="No crew" none="No crew" />
        </div>
      )}
    </ActionDialog>
  );
}

function Schedule({ page }: { page: JobPage }) {
  const { job } = page;
  const [dueAt, setDueAt] = useState(toLocalInput(job.dueAt));
  const [priority, setPriority] = useState<WorkPriority>(job.priority);
  return (
    <ActionDialog
      label="Reschedule"
      icon={<CalendarClockIcon />}
      title="Reschedule this job"
      submitLabel="Save"
      success="Schedule saved"
      canSubmit={dueAt !== ""}
      onSubmit={async () => scheduleJob(job.id, new Date(dueAt).toISOString(), priority)}
    >
      <div className="grid gap-2">
        <Label htmlFor="schedule-due">Due</Label>
        <Input id="schedule-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="schedule-priority">Priority</Label>
        <FieldSelect
          id="schedule-priority"
          value={priority}
          onChange={(v) => setPriority(v as WorkPriority)}
          options={WORK_PRIORITIES.map((p) => ({ value: p, label: priorityLabel[p] }))}
          placeholder="Priority"
        />
      </div>
    </ActionDialog>
  );
}

function Finalize({ page }: { page: JobPage }) {
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Finalize"
      icon={<CheckIcon />}
      title="Finalize this parent job"
      description="Closes the job from wherever it is. Child jobs still open are recorded, not blocked."
      submitLabel="Finalize"
      success="Job finalized"
      onSubmit={async () => settled(await finalizeJob({ eventId: crypto.randomUUID(), workOrderId: page.job.id, outcome: "done", note }))}
    >
      <div className="grid gap-2">
        <Label htmlFor="finalize-note">Note (optional)</Label>
        <Textarea id="finalize-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function Cancel({ page }: { page: JobPage }) {
  const [cascade, setCascade] = useState(false);
  const open = page.children.filter((c) => c.status !== "completed" && c.status !== "cancelled").length;
  return (
    <ActionDialog
      label="Cancel job"
      icon={<BanIcon />}
      variant="destructive"
      title="Cancel this job"
      description="A cancelled job can't be reopened, and its network branch can only be discarded."
      submitLabel="Cancel job"
      success="Job cancelled"
      onSubmit={() => cancelJob(page.job.id, cascade)}
    >
      {open > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={cascade} onCheckedChange={(v) => setCascade(v === true)} />
          Also cancel the {open} child {open === 1 ? "job" : "jobs"} that haven&apos;t started
        </label>
      )}
    </ActionDialog>
  );
}
