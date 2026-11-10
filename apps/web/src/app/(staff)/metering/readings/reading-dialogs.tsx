"use client";

import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { emptyReading, MeterPicker, ReadingFields, type FoundMeter, type ReadingDraft } from "@/components/metering/meter-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { canConfirmRollover, instantFromLocal, nowLocalInput } from "@/lib/metering-view";
import { approveReadingAction, recordReadingAction, voidReadingAction } from "../actions";

/** M-04: office entry of a reading. Validation runs as for a technician's; a flagged reading waits for review. */
export function RecordReadingDialog() {
  const [id, mint] = useMintedId();
  const [meter, setMeter] = useState<FoundMeter | null>(null);
  const [when, setWhen] = useState(nowLocalInput());
  const [draft, setDraft] = useState<ReadingDraft>(emptyReading);
  return (
    <ActionDialog
      label="Record a reading"
      icon={<PlusIcon />}
      variant="default"
      title="Record a reading"
      description="Entered by the office. The same checks run as for a technician's reading: a doubtful one is flagged and held out of automatic billing until a reviewer clears it."
      submitLabel="Record reading"
      success="Reading recorded"
      onOpen={() => {
        mint();
        setDraft(emptyReading);
      }}
      canSubmit={meter !== null && draft.value.trim() !== ""}
      onSubmit={async () => {
        if (!meter) return { error: "Find the meter first" };
        const result = await recordReadingAction({ id, meterId: meter.id, dialDigits: meter.dialDigits, value: draft.value, readAt: instantFromLocal(when)?.toISOString() ?? "", quality: draft.quality, note: draft.note, rollover: draft.rollover });
        return { error: result.error };
      }}
    >
      <MeterPicker id="record-meter" found={meter} onFound={setMeter} />
      <div className="grid gap-1.5">
        <Label htmlFor="record-when">Read at</Label>
        <Input id="record-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" required />
      </div>
      <ReadingFields idPrefix="record" draft={draft} onChange={setDraft} digits={meter?.dialDigits} legend="Reading" />
    </ActionDialog>
  );
}

/** M-05, M-07: a reviewer clears a flagged reading (confirming a rollover where it fits) or voids it. Both need a reason. */
export function ReviewButtons({ readingId, flags, rolloverConfirmed }: { readingId: string; flags: readonly string[]; rolloverConfirmed: boolean }) {
  const [reason, setReason] = useState("");
  const [rollover, setRollover] = useState(false);
  const candidate = canConfirmRollover({ flags, rolloverConfirmed });
  return (
    <div className="flex gap-1.5">
      <ActionDialog
        label="Approve"
        icon={<CheckIcon />}
        title="Approve this reading"
        description={candidate ? "The dial dropped below the previous reading. Confirm it went round and the units will count the wrap, or approve it as it stands." : "Clears the reading for billing. The flags stay on record."}
        submitLabel={rollover ? "Approve as rollover" : "Approve"}
        success="Reading approved"
        onOpen={() => {
          setReason("");
          setRollover(false);
        }}
        canSubmit={reason.trim() !== ""}
        onSubmit={async () => ({ error: (await approveReadingAction({ readingId, rollover, reason })).error })}
      >
        {candidate && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
            Confirm rollover: the dial went round
          </label>
        )}
        <div className="grid gap-2">
          <Label htmlFor={`approve-${readingId}`}>Reason</Label>
          <Textarea id={`approve-${readingId}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
        </div>
      </ActionDialog>
      <VoidButton readingId={readingId} />
    </div>
  );
}

/** Takes a reading out of use; it stays in the history. */
export function VoidButton({ readingId }: { readingId: string }) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog
      label="Void"
      icon={<XIcon />}
      variant="ghost"
      title="Void this reading"
      description="The reading is taken out of use but stays in the history. A bill already made on it will need a correction."
      submitLabel="Void reading"
      success="Reading voided"
      onOpen={() => setReason("")}
      canSubmit={reason.trim() !== ""}
      onSubmit={async () => ({ error: (await voidReadingAction({ readingId, reason })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`void-${readingId}`}>Reason</Label>
        <Textarea id={`void-${readingId}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}
