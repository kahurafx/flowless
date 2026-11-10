"use client";

import { LinkIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Label } from "@/components/ui/label";
import { closingCandidatesAction, linkClosingAction } from "../actions";

/** C-08, C-10: names the actual reading that closes the old holder's account on the handover. */
export function LinkClosingDialog({ handoverId, meterId, locale }: { handoverId: string; meterId: string; locale: string }) {
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);
  const [readingId, setReadingId] = useState("");
  return (
    <ActionDialog
      label="Link closing reading"
      icon={<LinkIcon />}
      title="Link the closing reading"
      description="Choose the valid, actual reading that was taken when the account changed hands. An estimate cannot close a handover."
      submitLabel="Link reading"
      success="Closing reading linked"
      onOpen={async () => {
        setReadingId("");
        const rows = await closingCandidatesAction(meterId);
        setOptions(rows.map((r) => ({ value: r.id, label: `${r.value} on ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(r.readAt))}` })));
      }}
      canSubmit={readingId !== ""}
      onSubmit={async () => ({ error: (await linkClosingAction({ handoverId, readingId })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor={`closing-${handoverId}`}>Reading</Label>
        {options === null ? (
          <p className="text-sm text-muted-foreground">Loading readings…</p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">This meter has no valid actual reading yet. Record one first (Readings), then link it here.</p>
        ) : (
          <FieldSelect id={`closing-${handoverId}`} value={readingId} onChange={setReadingId} options={options} placeholder="Choose a reading" />
        )}
      </div>
    </ActionDialog>
  );
}
