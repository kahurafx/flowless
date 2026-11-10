"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CASE_KINDS, CASE_KIND_LABELS } from "@/lib/case-view";
import { openCaseAction } from "./actions";

/** B-19: opens a case and puts it in the exception queue, owned by whoever opened it. */
export function OpenCaseDialog() {
  const router = useRouter();
  const [id, mint] = useMintedId();
  const [kind, setKind] = useState("");
  const [number, setNumber] = useState("");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  return (
    <ActionDialog
      label="Open a case"
      icon={<PlusIcon />}
      variant="default"
      title="Open a revenue case"
      description="A case is a log: what was suspected, the evidence added, and one decision. It sits in the exception queue until it is resolved."
      submitLabel="Open case"
      success="Case opened"
      onOpen={mint}
      canSubmit={kind !== "" && number.trim() !== "" && title.trim() !== ""}
      onSubmit={async () => {
        const result = await openCaseAction({ id, kind, accountNumber: number, title, detail });
        if (result.error === null) router.push(`/billing/cases/${result.data.id}`);
        return { error: result.error };
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="case-kind">Kind</Label>
        <FieldSelect id="case-kind" value={kind} onChange={setKind} options={CASE_KINDS.map((k) => ({ value: k, label: CASE_KIND_LABELS[k] }))} placeholder="Choose a kind" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="case-account">Account number</Label>
        <Input id="case-account" value={number} onChange={(e) => setNumber(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="case-title">Title</Label>
        <Input id="case-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="case-detail">Detail (optional)</Label>
        <Textarea id="case-detail" value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}
