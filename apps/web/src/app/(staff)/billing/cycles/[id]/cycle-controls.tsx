"use client";

import { ArrowLeftIcon, ArrowRightIcon, LockIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CYCLE_STATE_LABELS, moveNeedsReason, moveOptions, type CycleStateKey } from "@/lib/cycle-view";
import { advanceCycleAction, closeCycleAction, runCycleAction } from "../actions";

/** Advance to the next state; skipping ahead and going back are offered too and need a reason (B-02). */
function MoveDialog({ cycleId, state, mode }: { cycleId: string; state: CycleStateKey; mode: "next" | "skip" | "back" }) {
  const options = moveOptions(state);
  const choices = mode === "next" ? (options.next ? [options.next] : []) : mode === "skip" ? options.skip : options.back;
  const [id, mint] = useMintedId();
  const [to, setTo] = useState<string>(choices[0] ?? "");
  const [reason, setReason] = useState("");
  if (choices.length === 0) return null;
  const target = (choices.find((c) => c === to) ?? choices[0])!;
  const needsReason = moveNeedsReason(state, target);
  const label = mode === "next" ? `Advance to ${CYCLE_STATE_LABELS[target]}` : mode === "skip" ? "Skip ahead" : "Go back";
  return (
    <ActionDialog
      label={label}
      icon={mode === "back" ? <ArrowLeftIcon /> : <ArrowRightIcon />}
      variant={mode === "next" ? "default" : "outline"}
      title={label}
      description={mode === "next" ? `The cycle moves from ${CYCLE_STATE_LABELS[state]} to ${CYCLE_STATE_LABELS[target]}. Entering estimation or calculation queues the per-account jobs.` : "Every move is logged with its reason. A cycle never goes back to open."}
      submitLabel={mode === "back" ? "Go back" : mode === "skip" ? "Skip ahead" : "Advance"}
      success="Cycle moved"
      onOpen={() => {
        mint();
        setReason("");
        setTo(choices[0] ?? "");
      }}
      canSubmit={!needsReason || reason.trim() !== ""}
      onSubmit={async () => ({ error: (await advanceCycleAction({ id, cycleId, from: state, to: target, reason })).error })}
    >
      {mode !== "next" && (
        <div className="grid gap-2">
          <Label htmlFor={`move-${mode}`}>Move to</Label>
          <FieldSelect id={`move-${mode}`} value={target} onChange={setTo} options={choices.map((c) => ({ value: c, label: CYCLE_STATE_LABELS[c] }))} placeholder="Choose a state" />
        </div>
      )}
      {needsReason && (
        <div className="grid gap-2">
          <Label htmlFor={`move-${mode}-reason`}>Reason</Label>
          <Textarea id={`move-${mode}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} required />
        </div>
      )}
    </ActionDialog>
  );
}

/** Close the cycle (B-04, B-15): refused while any expected account is unexplained, then locks the period. */
function CloseDialog({ cycleId, unexplained }: { cycleId: string; unexplained: number }) {
  const [id, mint] = useMintedId();
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Close cycle"
      icon={<LockIcon />}
      variant="destructive"
      title="Close this cycle"
      description={
        unexplained > 0
          ? `${unexplained} expected ${unexplained === 1 ? "account is" : "accounts are"} still unexplained, so the cycle will refuse to close. Resolve them first.`
          : "Closing locks the period for the accounts this cycle covered. Later changes are credit notes, debit notes or a re-bill."
      }
      submitLabel="Close cycle"
      success="Cycle closed"
      onOpen={mint}
      onSubmit={async () => ({ error: (await closeCycleAction({ id, cycleId, note })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="close-note">Note (optional)</Label>
        <Textarea id="close-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      </div>
    </ActionDialog>
  );
}

/** Run (queue accounts with no outcome) and retry (also the failed ones). Both are safe to repeat. */
function RunButtons({ cycleId }: { cycleId: string }) {
  const [pending, start] = useTransition();
  const go = (retry: boolean) =>
    start(async () => {
      const result = await runCycleAction({ cycleId, retry });
      if (result.error) toast.error(result.error);
      else toast.success(retry ? "Failed accounts queued again" : "Accounts queued");
    });
  return (
    <>
      <Button variant="outline" disabled={pending} onClick={() => go(false)}>
        <PlayIcon />
        Run
      </Button>
      <Button variant="outline" disabled={pending} onClick={() => go(true)}>
        <RotateCcwIcon />
        Retry failed
      </Button>
    </>
  );
}

export function CycleControls({ cycleId, state, unexplained, canRun }: { cycleId: string; state: CycleStateKey; unexplained: number; canRun: boolean }) {
  if (!canRun) return <p className="text-sm text-muted-foreground">You can read this cycle. Running it needs permission to run billing.</p>;
  if (state === "closed") return <p className="text-sm text-muted-foreground">This cycle is closed and its period is locked. Corrections are credit notes, debit notes or a re-bill on the account.</p>;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Cycle actions">
      <MoveDialog cycleId={cycleId} state={state} mode="next" />
      <MoveDialog cycleId={cycleId} state={state} mode="skip" />
      <MoveDialog cycleId={cycleId} state={state} mode="back" />
      <RunButtons cycleId={cycleId} />
      {moveOptions(state).canClose && <CloseDialog cycleId={cycleId} unexplained={unexplained} />}
    </div>
  );
}
