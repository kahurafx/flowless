"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { reasonPayload } from "@/lib/reason-payload";

/** A client-minted id, fresh for each opening of a dialog: a retried submit replays, a new attempt acts. */
export function useMintedId() {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())] as const;
}

/** The state every status-changing dialog shares: a minted id, a reason and an optional note (C-03). */
export function useReasonForm() {
  const [id, mint] = useMintedId();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  return { id, mint, reason, setReason, note, setNote, payload: () => reasonPayload(id, reason, note) };
}

export type ReasonForm = ReturnType<typeof useReasonForm>;

/** The reason box alone, for dialogs that take no note. */
export function ReasonField({ idPrefix, form, label = "Reason" }: { idPrefix: string; form: ReasonForm; label?: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`${idPrefix}-reason`}>{label}</Label>
      <Textarea id={`${idPrefix}-reason`} value={form.reason} onChange={(e) => form.setReason(e.target.value)} rows={2} maxLength={500} required />
    </div>
  );
}

/** The optional note box, for dialogs that choose their reason another way. */
export function NoteField({ idPrefix, form }: { idPrefix: string; form: ReasonForm }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`${idPrefix}-note`}>Note (optional)</Label>
      <Textarea id={`${idPrefix}-note`} value={form.note} onChange={(e) => form.setNote(e.target.value)} rows={2} maxLength={2000} />
    </div>
  );
}

/** Reason, and an optional note: every status change records both (C-03). */
export function ReasonFields({ idPrefix, form, label }: { idPrefix: string; form: ReasonForm; label?: string }) {
  return (
    <>
      <ReasonField idPrefix={idPrefix} form={form} {...(label ? { label } : {})} />
      <NoteField idPrefix={idPrefix} form={form} />
    </>
  );
}
