"use client";

import { ASSET_CONDITIONS, PIPE_MATERIALS, type AssetCondition, type NodeType, type PipeMaterial } from "@flowless/shared-types";
import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createNode, createPipe, type LatLng } from "./actions";
import { conditionLabel, materialLabel, NODE_TYPE_SINGULAR, NODE_TYPES } from "./map-config";

export const conditionOptions = ASSET_CONDITIONS.map((c) => ({ value: c, label: conditionLabel[c] }));

/** Place a node where the map was clicked, on the branch being edited. */
export function NewNodeDialog({ branch, at, onClose }: { branch: string; at: LatLng | null; onClose: () => void }) {
  const [type, setType] = useState<NodeType>("valve");
  const [name, setName] = useState("");
  const [condition, setCondition] = useState<AssetCondition>("unknown");
  const [isOpen, setIsOpen] = useState(true);
  return (
    <ActionDialog
      key={at ? `${at.lat},${at.lng}` : "closed"}
      controlled={{ open: at !== null, onOpenChange: (open) => !open && onClose() }}
      label="New node"
      title="Place a node"
      description={at ? `At ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)} on ${branch === "main" ? "the live network" : `branch ${branch}`}.` : undefined}
      submitLabel="Place node"
      success="Node placed"
      canSubmit={name.trim() !== "" && at !== null}
      onSubmit={async () => {
        const result = await createNode({ branch, type, name: name.trim(), location: at!, condition, isOpen: type === "valve" ? isOpen : null });
        if (result.error === null) onClose();
        return result;
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="node-type">Type</Label>
        <FieldSelect id="node-type" value={type} onChange={(v) => setType(v as NodeType)} options={NODE_TYPES.map((t) => ({ value: t, label: NODE_TYPE_SINGULAR[t] }))} placeholder="Type" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="node-name">Name</Label>
        <Input id="node-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="For example V-101" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="node-condition">Condition</Label>
        <FieldSelect id="node-condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} placeholder="Condition" />
      </div>
      {type === "valve" && (
        <div className="grid gap-2">
          <Label htmlFor="node-open">Valve state</Label>
          <FieldSelect
            id="node-open"
            value={isOpen ? "open" : "closed"}
            onChange={(v) => setIsOpen(v === "open")}
            options={[
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ]}
            placeholder="State"
          />
        </div>
      )}
    </ActionDialog>
  );
}

export interface PipeDraft {
  fromNodeId: string;
  toNodeId: string;
  path: LatLng[];
  fromName: string;
  toName: string;
}

/** Details for a pipe drawn between two nodes; its length is computed from the path by the server. */
export function NewPipeDialog({ branch, draft, onClose }: { branch: string; draft: PipeDraft | null; onClose: () => void }) {
  const [material, setMaterial] = useState<PipeMaterial>("pvc");
  const [diameter, setDiameter] = useState("100");
  const [condition, setCondition] = useState<AssetCondition>("unknown");
  const diameterMm = Number(diameter);
  return (
    <ActionDialog
      key={draft ? `${draft.fromNodeId}-${draft.toNodeId}-${draft.path.length}` : "closed"}
      controlled={{ open: draft !== null, onOpenChange: (open) => !open && onClose() }}
      label="New pipe"
      title="Add a pipe"
      description={draft ? `From ${draft.fromName} to ${draft.toName}.` : undefined}
      submitLabel="Add pipe"
      success="Pipe added"
      canSubmit={draft !== null && Number.isFinite(diameterMm) && diameterMm > 0}
      onSubmit={async () => {
        const result = await createPipe({ branch, fromNodeId: draft!.fromNodeId, toNodeId: draft!.toNodeId, path: draft!.path, material, diameterMm, condition });
        if (result.error === null) onClose();
        return result;
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="pipe-material">Material</Label>
        <FieldSelect id="pipe-material" value={material} onChange={(v) => setMaterial(v as PipeMaterial)} options={PIPE_MATERIALS.map((m) => ({ value: m, label: materialLabel[m] ?? m }))} placeholder="Material" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pipe-diameter">Diameter (mm)</Label>
        <Input id="pipe-diameter" type="number" inputMode="numeric" min={1} max={5000} value={diameter} onChange={(e) => setDiameter(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="pipe-condition">Condition</Label>
        <FieldSelect id="pipe-condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} placeholder="Condition" />
      </div>
    </ActionDialog>
  );
}
