"use client";

import { PencilIcon, PowerIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateTariffAction } from "../actions";

/** Rename and switch off (or on): the type, basis and versions never change. */
export function TariffActions({ id, name, active }: { id: string; name: string; active: boolean }) {
  const [text, setText] = useState(name);
  return (
    <>
      <ActionDialog
        label="Rename"
        icon={<PencilIcon />}
        title="Rename tariff"
        submitLabel="Save"
        success="Tariff renamed"
        canSubmit={text.trim() !== "" && text.trim() !== name}
        onOpen={() => setText(name)}
        onSubmit={() => updateTariffAction({ id, name: text })}
      >
        <div className="grid gap-2">
          <Label htmlFor="rename-tariff">Name</Label>
          <Input id="rename-tariff" value={text} onChange={(e) => setText(e.target.value)} maxLength={120} required />
        </div>
      </ActionDialog>
      <ActionDialog
        label={active ? "Deactivate" : "Reactivate"}
        icon={<PowerIcon />}
        variant={active ? "outline" : "default"}
        title={active ? "Deactivate this tariff?" : "Reactivate this tariff?"}
        description={active ? "It can no longer be chosen for a category. Categories already using it, and its history, are untouched." : "It can be chosen for categories again."}
        submitLabel={active ? "Deactivate" : "Reactivate"}
        success={active ? "Tariff deactivated" : "Tariff reactivated"}
        onSubmit={() => updateTariffAction({ id, active: !active })}
      />
    </>
  );
}
