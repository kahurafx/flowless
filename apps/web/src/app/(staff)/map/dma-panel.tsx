"use client";

import type { DmaMembership } from "@flowless/network";
import { PencilIcon, PenLineIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { DmaDto, NodeDto, TierDto } from "@/data/gis";
import { createDma, updateDma, type LatLng } from "./actions";
import { DMA_PALETTE } from "./map-config";

export type DrawPurpose = { type: "create"; areaId: string; name: string } | { type: "redraw"; dmaId: string; name: string };

function ValvePicker({ valves, selected, onChange }: { valves: readonly NodeDto[]; selected: readonly string[]; onChange: (ids: string[]) => void }) {
  if (valves.length === 0) return <p className="text-sm text-muted-foreground">No valves are mapped yet.</p>;
  return (
    <ul className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-1" aria-label="Boundary valves">
      {valves.map((v) => (
        <li key={v.id}>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
            <Checkbox checked={selected.includes(v.id)} onCheckedChange={() => onChange(selected.includes(v.id) ? selected.filter((s) => s !== v.id) : [...selected, v.id])} />
            {v.name}
            <span className="ml-auto text-xs text-muted-foreground">{v.isOpen === false ? "closed" : "open"}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Colour, inlet meter and boundary valves of a DMA that already has map data. */
function EditDma({ dma, nodes, branch }: { dma: DmaDto; nodes: readonly NodeDto[]; branch: string }) {
  const [color, setColor] = useState(dma.color);
  const [inlet, setInlet] = useState(dma.inletMeterId ?? "");
  const [valves, setValves] = useState<string[]>(dma.boundaryValveIds);
  const meters = nodes.filter((n) => n.type === "meter");
  const valveNodes = nodes.filter((n) => n.type === "valve");
  const valvesChanged = JSON.stringify([...valves].sort()) !== JSON.stringify([...dma.boundaryValveIds].sort());
  const changed = color !== dma.color || inlet !== (dma.inletMeterId ?? "") || valvesChanged;
  return (
    <ActionDialog
      label="Inlet and valves"
      icon={<SettingsIcon />}
      title={`Edit ${dma.name}`}
      description="Boundary valves are the ones that should stay closed to seal this DMA. Membership is traced from the inlet meter."
      submitLabel="Save"
      success="DMA saved"
      canSubmit={inlet !== "" && changed}
      onSubmit={() =>
        updateDma({
          branch,
          id: dma.id,
          baseVersionId: dma.versionId,
          patch: {
            ...(color !== dma.color ? { color } : {}),
            ...(inlet !== (dma.inletMeterId ?? "") ? { inletMeterId: inlet } : {}),
            ...(valvesChanged ? { boundaryValveIds: valves } : {}),
          },
        })
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="dma-inlet">Inlet meter</Label>
        <FieldSelect id="dma-inlet" value={inlet} onChange={setInlet} options={meters.map((m) => ({ value: m.id, label: m.name }))} placeholder="Choose a meter" />
      </div>
      <div className="grid gap-2">
        <Label>Colour</Label>
        <ColorChoice value={color} onChange={setColor} />
      </div>
      <div className="grid gap-2">
        <Label>Boundary valves</Label>
        <ValvePicker valves={valveNodes} selected={valves} onChange={setValves} />
      </div>
    </ActionDialog>
  );
}

function ColorChoice({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
      {DMA_PALETTE.map((hex) => (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === hex}
          aria-label={hex}
          onClick={() => onChange(hex)}
          className="size-8 rounded-lg border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:border-foreground pointer-coarse:size-11"
          style={{ background: hex }}
        />
      ))}
    </div>
  );
}

/** After a boundary is drawn for a DMA without map data: its tier, inlet meter, valves and colour. */
export function NewDmaDialog({
  branch,
  purpose,
  ring,
  nodes,
  tiers,
  onClose,
}: {
  branch: string;
  purpose: Extract<DrawPurpose, { type: "create" }> | null;
  ring: LatLng[] | null;
  nodes: readonly NodeDto[];
  tiers: readonly TierDto[];
  onClose: () => void;
}) {
  const defaultTier = tiers.find((t) => t.name.toLowerCase() === "dma") ?? tiers[tiers.length - 1];
  const [tierId, setTierId] = useState(defaultTier?.id ?? "");
  const [inlet, setInlet] = useState("");
  const [valves, setValves] = useState<string[]>([]);
  const [color, setColor] = useState<string>(DMA_PALETTE[0]);
  const meters = nodes.filter((n) => n.type === "meter");
  return (
    <ActionDialog
      key={ring ? ring.length + (purpose?.areaId ?? "") : "closed"}
      controlled={{ open: purpose !== null && ring !== null, onOpenChange: (open) => !open && onClose() }}
      label="New DMA"
      title={purpose ? `Map ${purpose.name}` : "Map a DMA"}
      description="The inlet meter is where the DMA's water is counted. Tracing downstream from it decides which assets belong."
      submitLabel="Save DMA"
      success="DMA mapped"
      canSubmit={tierId !== "" && inlet !== ""}
      onSubmit={async () => {
        const result = await createDma({ branch, areaId: purpose!.areaId, color, tierId, inletMeterId: inlet, boundaryValveIds: valves, ring: ring! });
        if (result.error === null) onClose();
        return result;
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="new-dma-inlet">Inlet meter</Label>
        <FieldSelect id="new-dma-inlet" value={inlet} onChange={setInlet} options={meters.map((m) => ({ value: m.id, label: m.name }))} placeholder={meters.length ? "Choose a meter" : "No meters are mapped yet"} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-dma-tier">Tier</Label>
        <FieldSelect id="new-dma-tier" value={tierId} onChange={setTierId} options={tiers.map((t) => ({ value: t.id, label: t.name }))} placeholder="Choose a tier" />
      </div>
      <div className="grid gap-2">
        <Label>Colour</Label>
        <ColorChoice value={color} onChange={setColor} />
      </div>
      <div className="grid gap-2">
        <Label>Boundary valves</Label>
        <ValvePicker valves={nodes.filter((n) => n.type === "valve")} selected={valves} onChange={setValves} />
      </div>
    </ActionDialog>
  );
}

interface Props {
  dmas: readonly DmaDto[];
  undrawn: readonly { id: string; name: string }[];
  nodes: readonly NodeDto[];
  branch: string;
  writable: boolean;
  selectedId: string | null;
  membership: DmaMembership | null;
  isolatedId: string | null;
  drawing: DrawPurpose | null;
  onSelect: (id: string | null) => void;
  onIsolate: (id: string | null) => void;
  onDraw: (purpose: DrawPurpose) => void;
}

export function DmaPanel({ dmas, undrawn, nodes, branch, writable, selectedId, membership, isolatedId, drawing, onSelect, onIsolate, onDraw }: Props) {
  const selected = dmas.find((d) => d.id === selectedId) ?? null;
  const [area, setArea] = useState("");
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? "A node";
  return (
    <div className="grid gap-4">
      {dmas.length === 0 && <p className="text-sm text-muted-foreground">No DMA has a boundary on the map yet.</p>}
      <ul className="grid gap-1" aria-label="DMAs">
        {dmas.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              aria-pressed={selectedId === d.id}
              onClick={() => onSelect(selectedId === d.id ? null : d.id)}
              className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:font-medium"
            >
              <span className="size-3 shrink-0 rounded-sm" style={{ background: d.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
            </button>
          </li>
        ))}
      </ul>

      {selected && membership && (
        <div className="grid gap-3 rounded-xl border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{selected.name}</h3>
            {membership.sealed ? <Badge variant="success">Sealed</Badge> : <Badge variant="warning">Not sealed</Badge>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">Fed from the inlet</dt>
            <dd className="tabular">{membership.tracedIds.length} assets</dd>
            <dt className="text-muted-foreground">Inside the boundary</dt>
            <dd className="tabular">{membership.insideIds.length} assets</dd>
            {membership.outsideBoundary.length > 0 && (
              <>
                <dt className="text-destructive">Outside the boundary</dt>
                <dd className="tabular text-destructive">{membership.outsideBoundary.length} fed but outside</dd>
              </>
            )}
            {membership.insideNotTraced.length > 0 && (
              <>
                <dt className="text-muted-foreground">Not fed</dt>
                <dd className="tabular">{membership.insideNotTraced.length} inside but not fed</dd>
              </>
            )}
          </dl>
          {membership.openBoundaryValveIds.length > 0 && (
            <p className="text-warning">Boundary valves not confirmed closed: {membership.openBoundaryValveIds.map(nameOf).join(", ")}.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onIsolate(isolatedId === selected.id ? null : selected.id)}>
              {isolatedId === selected.id ? "Show everything" : "Show on its own"}
            </Button>
            {writable && <EditDma dma={selected} nodes={nodes} branch={branch} />}
            {writable && (
              <Button variant="outline" disabled={drawing !== null} onClick={() => onDraw({ type: "redraw", dmaId: selected.id, name: selected.name })}>
                <PencilIcon />
                Redraw boundary
              </Button>
            )}
          </div>
        </div>
      )}

      {writable && undrawn.length > 0 && (
        <div className="grid gap-2 rounded-xl border border-dashed p-3">
          <Label htmlFor="undrawn-dma">Map a DMA that has no boundary yet</Label>
          <FieldSelect id="undrawn-dma" value={area} onChange={setArea} options={undrawn.map((a) => ({ value: a.id, label: a.name }))} placeholder="Choose a DMA" />
          <Button
            variant="outline"
            disabled={!area || drawing !== null}
            onClick={() => {
              const found = undrawn.find((a) => a.id === area);
              if (found) onDraw({ type: "create", areaId: found.id, name: found.name });
            }}
          >
            <PenLineIcon />
            Draw its boundary
          </Button>
        </div>
      )}
    </div>
  );
}
