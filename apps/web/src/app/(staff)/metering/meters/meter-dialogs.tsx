"use client";

import { ArrowRightLeftIcon, PlugZapIcon, PlusIcon, RepeatIcon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { useMintedId } from "@/components/accounts/reason-form";
import { FieldSelect } from "@/components/field-select";
import { emptyReading, MeterPicker, ReadingFields, type FoundMeter, type ReadingDraft } from "@/components/metering/meter-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { METER_KIND_LABELS, METER_STATUS_LABELS, REMOVE_TARGETS, instantFromLocal, nowLocalInput, statusMoves } from "@/lib/metering-view";
import type { MeterStatus } from "@flowless/shared-types";
import { changeMeterStatusAction, installMeterAction, registerMeterAction, removeMeterAction, replaceMeterAction, servicePointsOfAccountAction } from "../actions";

const iso = (local: string) => instantFromLocal(local)?.toISOString() ?? "";
const boundary = (d: ReadingDraft) => ({ value: d.value, quality: d.quality, note: d.note, rollover: d.rollover });

/** M-01, M-12: a new meter enters the register in stock or as procured. */
export function RegisterMeterDialog({ dmas }: { dmas: { value: string; label: string }[] }) {
  const [id, mint] = useMintedId();
  const [serial, setSerial] = useState("");
  const [model, setModel] = useState("");
  const [digits, setDigits] = useState("5");
  const [status, setStatus] = useState<"procured" | "in_stock">("in_stock");
  const [kind, setKind] = useState("customer");
  const [dmaId, setDmaId] = useState("");
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Register a meter"
      icon={<PlusIcon />}
      variant="default"
      title="Register a meter"
      description="A meter enters the register by serial number. Installing it on a service point is a separate step."
      submitLabel="Register"
      success="Meter registered"
      onOpen={mint}
      canSubmit={serial.trim() !== ""}
      onSubmit={async () => ({ error: (await registerMeterAction({ id, serial, model, dialDigits: digits, status, kind, dmaId, note })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="reg-serial">Serial number</Label>
        <Input id="reg-serial" value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={64} required />
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-2">
          <Label htmlFor="reg-model">Model (optional)</Label>
          <Input id="reg-model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-digits">Dial digits</Label>
          <Input id="reg-digits" value={digits} onChange={(e) => setDigits(e.target.value)} inputMode="numeric" className="w-24" />
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-2">
          <Label htmlFor="reg-status">Enters as</Label>
          <FieldSelect id="reg-status" value={status} onChange={(v) => setStatus(v === "procured" ? "procured" : "in_stock")} options={[{ value: "in_stock", label: "In stock" }, { value: "procured", label: "Procured" }]} placeholder="Status" className="w-36" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reg-kind">Kind</Label>
          <FieldSelect id="reg-kind" value={kind} onChange={(v) => setKind(v || "customer")} options={Object.entries(METER_KIND_LABELS).map(([value, label]) => ({ value, label }))} placeholder="Kind" className="w-44" />
        </div>
      </div>
      {kind !== "customer" && (
        <div className="grid gap-2">
          <Label htmlFor="reg-dma">DMA it measures</Label>
          <FieldSelect id="reg-dma" value={dmaId} onChange={setDmaId} options={dmas} placeholder="Choose a DMA" />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="reg-note">Note (optional)</Label>
        <Textarea id="reg-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      </div>
    </ActionDialog>
  );
}

/** M-01: a status move with a reason. Installed and replaced are reached by install, remove and replace. */
export function StatusDialog({ meterId, status }: { meterId: string; status: MeterStatus }) {
  const moves = statusMoves(status);
  const [id, mint] = useMintedId();
  const [to, setTo] = useState<string>(moves[0] ?? "");
  const [reason, setReason] = useState("");
  if (moves.length === 0) return null;
  return (
    <ActionDialog
      label="Change status"
      icon={<ArrowRightLeftIcon />}
      title="Change the meter's status"
      description="Every move is logged with its reason. Installing, removing and replacing have their own buttons."
      submitLabel="Change status"
      success="Status changed"
      onOpen={mint}
      canSubmit={reason.trim() !== "" && moves.some((m) => m === to)}
      onSubmit={async () => ({ error: (await changeMeterStatusAction({ id, meterId, to, reason })).error })}
    >
      <div className="grid gap-2">
        <Label htmlFor="status-to">Move to</Label>
        <FieldSelect id="status-to" value={to} onChange={setTo} options={moves.map((m) => ({ value: m, label: METER_STATUS_LABELS[m] }))} placeholder="Choose a status" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="status-reason">Reason</Label>
        <Textarea id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
    </ActionDialog>
  );
}

/** M-01, M-07: install on a service point (found through its account), optionally with the first reading. */
export function InstallDialog({ meterId, dialDigits }: { meterId: string; dialDigits: number }) {
  const [id, mint] = useMintedId();
  const [number, setNumber] = useState("");
  const [points, setPoints] = useState<{ id: string; address: string; status: string }[] | null>(null);
  const [lookup, setLookup] = useState<string | null>(null);
  const [pointId, setPointId] = useState("");
  const [when, setWhen] = useState(nowLocalInput());
  const [withReading, setWithReading] = useState(true);
  const [initial, setInitial] = useState<ReadingDraft>(emptyReading);
  const find = async () => {
    const result = await servicePointsOfAccountAction(number);
    if (result.error !== null) {
      setPoints(null);
      setLookup(result.error);
    } else {
      setLookup(`${result.data.accountName}: ${result.data.points.length} service point${result.data.points.length === 1 ? "" : "s"}`);
      setPoints(result.data.points);
      setPointId(result.data.points.length === 1 ? result.data.points[0]!.id : "");
    }
  };
  return (
    <ActionDialog
      label="Install"
      icon={<PlugZapIcon />}
      title="Install this meter"
      description="One meter per service point, one service point per meter. The first reading is recorded with the installation."
      submitLabel="Install"
      success="Meter installed"
      onOpen={() => {
        mint();
        setInitial(emptyReading);
      }}
      canSubmit={pointId !== "" && (!withReading || initial.value.trim() !== "")}
      onSubmit={async () => ({ error: (await installMeterAction({ id, meterId, dialDigits, servicePointId: pointId, installedAt: iso(when), initial: withReading ? boundary(initial) : null })).error })}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="install-account">Account number</Label>
        <div className="flex gap-2">
          <Input id="install-account" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="The account the service point belongs to" />
          <Button type="button" variant="outline" onClick={find} disabled={number.trim() === ""}>
            Find
          </Button>
        </div>
        {lookup && <p className="text-xs text-muted-foreground">{lookup}</p>}
      </div>
      {points && points.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor="install-point">Service point</Label>
          <FieldSelect id="install-point" value={pointId} onChange={setPointId} options={points.map((p) => ({ value: p.id, label: `${p.address} (${p.status.toLowerCase()})` }))} placeholder="Choose a service point" />
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="install-when">Installed at</Label>
        <Input id="install-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" required />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={withReading} onChange={(e) => setWithReading(e.target.checked)} />
        Record the initial reading
      </label>
      {withReading && <ReadingFields idPrefix="install" draft={initial} onChange={setInitial} digits={dialDigits} legend="Initial reading" />}
    </ActionDialog>
  );
}

/** M-01: take the meter off its service point, with the reading at removal. */
export function RemoveDialog({ meterId, dialDigits }: { meterId: string; dialDigits: number }) {
  const [id, mint] = useMintedId();
  const [when, setWhen] = useState(nowLocalInput());
  const [to, setTo] = useState<string>("in_stock");
  const [reason, setReason] = useState("");
  const [withReading, setWithReading] = useState(true);
  const [final, setFinal] = useState<ReadingDraft>(emptyReading);
  return (
    <ActionDialog
      label="Remove"
      icon={<UnplugIcon />}
      title="Remove this meter"
      description="Closes the installation. The reading at removal becomes the meter's final reading."
      submitLabel="Remove"
      success="Meter removed"
      onOpen={() => {
        mint();
        setFinal(emptyReading);
      }}
      canSubmit={reason.trim() !== "" && (!withReading || final.value.trim() !== "")}
      onSubmit={async () => ({ error: (await removeMeterAction({ id, meterId, dialDigits, removedAt: iso(when), to, reason, final: withReading ? boundary(final) : null })).error })}
    >
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="remove-when">Removed at</Label>
          <Input id="remove-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="remove-to">Goes to</Label>
          <FieldSelect id="remove-to" value={to} onChange={setTo} options={REMOVE_TARGETS.map((t) => ({ value: t, label: METER_STATUS_LABELS[t] }))} placeholder="Next status" className="w-40" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="remove-reason">Reason</Label>
        <Textarea id="remove-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={withReading} onChange={(e) => setWithReading(e.target.checked)} />
        Record the final reading
      </label>
      {withReading && <ReadingFields idPrefix="remove" draft={final} onChange={setFinal} digits={dialDigits} legend="Final reading" />}
    </ActionDialog>
  );
}

/** M-07: swap this meter for another on the same service point in one step: final reading of the old, initial of the new. */
export function ReplaceDialog({ meterId, dialDigits }: { meterId: string; dialDigits: number }) {
  const [id, mint] = useMintedId();
  const [next, setNext] = useState<FoundMeter | null>(null);
  const [when, setWhen] = useState(nowLocalInput());
  const [reason, setReason] = useState("");
  const [final, setFinal] = useState<ReadingDraft>(emptyReading);
  const [initial, setInitial] = useState<ReadingDraft>(emptyReading);
  return (
    <ActionDialog
      label="Replace"
      icon={<RepeatIcon />}
      title="Replace this meter"
      description="The old meter gets its final reading and is marked replaced; the new one is installed on the same service point with its initial reading. Billing uses both across the change."
      submitLabel="Replace"
      success="Meter replaced"
      onOpen={() => {
        mint();
        setFinal(emptyReading);
        setInitial(emptyReading);
        setNext(null);
      }}
      canSubmit={next !== null && reason.trim() !== "" && final.value.trim() !== "" && initial.value.trim() !== ""}
      onSubmit={async () =>
        next
          ? { error: (await replaceMeterAction({ id, oldMeterId: meterId, oldDigits: dialDigits, newMeterId: next.id, newDigits: next.dialDigits, replacedAt: iso(when), reason, final: boundary(final), initial: boundary(initial) })).error }
          : { error: "Find the new meter first" }
      }
    >
      <MeterPicker id="replace-new" label="New meter serial" found={next} onFound={setNext} />
      <div className="grid gap-1.5">
        <Label htmlFor="replace-when">Replaced at</Label>
        <Input id="replace-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="replace-reason">Reason</Label>
        <Textarea id="replace-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
      </div>
      <ReadingFields idPrefix="replace-final" draft={final} onChange={setFinal} digits={dialDigits} legend="Final reading, old meter" />
      <ReadingFields idPrefix="replace-initial" draft={initial} onChange={setInitial} digits={next?.dialDigits} legend="Initial reading, new meter" />
    </ActionDialog>
  );
}
