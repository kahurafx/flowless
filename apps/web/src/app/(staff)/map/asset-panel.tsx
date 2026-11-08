"use client";

import { PIPE_MATERIALS, type AssetCondition, type PipeMaterial } from "@flowless/shared-types";
import { ClipboardCheckIcon, MoveIcon, PencilIcon, ToggleLeftIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectionDto, NodeDto, PipeDto, StructureDto } from "@/data/gis";
import { formatWhen } from "@/lib/dates";
import { deleteAsset, deleteImpact, recordCondition, recordValveOperation, updateNode, updatePipe } from "./actions";
import { conditionOptions } from "./create-dialogs";
import { CONDITION_HEX, conditionLabel, materialLabel, NODE_TYPE_SINGULAR } from "./map-config";

export interface Selection {
  kind: "node" | "pipe" | "structure" | "connection";
  id: string;
}

interface Props {
  selection: Selection | null;
  nodes: readonly NodeDto[];
  pipes: readonly PipeDto[];
  structures: readonly StructureDto[];
  connections: readonly ConnectionDto[];
  branch: string;
  /** May this member change the network on this branch (the server checks again). */
  writable: boolean;
  canLog: boolean;
  canDelete: boolean;
  /** The job the branch belongs to, so a log can be linked to it. */
  jobId?: string;
  locale: string;
  timeZone: string;
  onMove: (nodeId: string) => void;
  onClear: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

const Condition = ({ value }: { value: AssetCondition }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="size-2.5 rounded-full" style={{ background: CONDITION_HEX[value] }} aria-hidden />
    {conditionLabel[value]}
  </span>
);

/** Details and the actions that save: edit, move, inspect, operate a valve, delete. */
export function AssetPanel(props: Props) {
  const { selection, nodes, pipes, structures, connections, locale, timeZone } = props;
  if (!selection) {
    return <p className="text-sm text-muted-foreground">Click a node, pipe or structure on the map to see it and act on it.</p>;
  }
  const date = (d: Date | null) => (d ? formatWhen(d, locale, timeZone, "date") : "Never");

  if (selection.kind === "node") {
    const node = nodes.find((n) => n.id === selection.id);
    if (!node) return <Gone onClear={props.onClear} />;
    return (
      <Shell title={node.name} subtitle={NODE_TYPE_SINGULAR[node.type]} onClear={props.onClear}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Condition">
            <Condition value={node.condition} />
          </Row>
          {node.type === "valve" && <Row label="Valve state">{node.isOpen === null ? "Unknown" : node.isOpen ? "Open" : "Closed"}</Row>}
          <Row label="Last inspected">{date(node.lastInspectedAt)}</Row>
          <Row label="Position">
            <span className="tabular">{node.location.lat.toFixed(5)}, {node.location.lng.toFixed(5)}</span>
          </Row>
        </dl>
        <div className="flex flex-wrap gap-2">
          {props.canLog && <Inspect assetId={node.id} current={node.condition} {...props} />}
          {props.canLog && node.type === "valve" && <Operate valve={node} {...props} />}
          {props.writable && <EditNode node={node} branch={props.branch} />}
          {props.writable && (
            <Button variant="outline" onClick={() => props.onMove(node.id)}>
              <MoveIcon />
              Move
            </Button>
          )}
          {props.writable && props.canDelete && <Remove kind="node" id={node.id} versionId={node.versionId} name={node.name} branch={props.branch} onDone={props.onClear} />}
        </div>
      </Shell>
    );
  }

  if (selection.kind === "pipe") {
    const pipe = pipes.find((p) => p.id === selection.id);
    if (!pipe) return <Gone onClear={props.onClear} />;
    const ends = [pipe.fromNodeId, pipe.toNodeId].map((id) => nodes.find((n) => n.id === id)?.name ?? "A node");
    return (
      <Shell title={`${pipe.diameterMm} mm ${materialLabel[pipe.material] ?? pipe.material} pipe`} subtitle={`${ends[0]} to ${ends[1]}`} onClear={props.onClear}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Condition">
            <Condition value={pipe.condition} />
          </Row>
          <Row label="Length">
            <span className="tabular">{Math.round(pipe.lengthM)} m</span>
          </Row>
        </dl>
        <div className="flex flex-wrap gap-2">
          {props.canLog && <Inspect assetId={pipe.id} current={pipe.condition} {...props} />}
          {props.writable && <EditPipe pipe={pipe} branch={props.branch} />}
          {props.writable && props.canDelete && <Remove kind="pipe" id={pipe.id} versionId={pipe.versionId} name="this pipe" branch={props.branch} onDone={props.onClear} />}
        </div>
      </Shell>
    );
  }

  if (selection.kind === "structure") {
    const structure = structures.find((s) => s.id === selection.id);
    if (!structure) return <Gone onClear={props.onClear} />;
    const housed = nodes.filter((n) => n.structureId === structure.id);
    return (
      <Shell title={structure.name} subtitle={structure.type} onClear={props.onClear}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Condition">
            <Condition value={structure.condition} />
          </Row>
          <Row label="Last inspected">{date(structure.lastInspectedAt)}</Row>
          <Row label="Houses">{housed.length ? housed.map((n) => n.name).join(", ") : "Nothing mapped"}</Row>
        </dl>
        {props.canLog && <Inspect assetId={structure.id} current={structure.condition} {...props} />}
      </Shell>
    );
  }

  const connection = connections.find((c) => c.id === selection.id);
  if (!connection) return <Gone onClear={props.onClear} />;
  const pipe = pipes.find((p) => p.id === connection.pipeId);
  return (
    <Shell title={`Connection ${connection.connectionNumber}`} subtitle="Service connection" onClear={props.onClear}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="Served by">{pipe ? `${pipe.diameterMm} mm ${materialLabel[pipe.material] ?? pipe.material} pipe` : "Not linked to a pipe"}</Row>
        <Row label="Service point">{connection.servicePointId ? "Linked in Accounts" : "Not linked yet"}</Row>
      </dl>
    </Shell>
  );
}

function Gone({ onClear }: { onClear: () => void }) {
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-muted-foreground">That asset is not on this branch any more.</p>
      <Button variant="outline" onClick={onClear} className="justify-self-start">
        Clear selection
      </Button>
    </div>
  );
}

function Shell({ title, subtitle, onClear, children }: { title: string; subtitle: string; onClear: () => void; children: React.ReactNode }) {
  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold break-words">{title}</h3>
          <p className="text-sm text-muted-foreground capitalize">{subtitle}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClear} aria-label="Clear selection">
          <XIcon />
        </Button>
      </div>
      {children}
    </div>
  );
}

const describeOutcome = (outcome: string, linked: string | null) =>
  [outcome === "stale" ? "Recorded. The asset itself was left as it is (a newer record exists, or this branch isn't yours to change)." : outcome === "unchanged" ? "Recorded. Nothing about the asset changed." : "Recorded.", linked].filter(Boolean).join(" ");

function Inspect({ assetId, current, branch, jobId }: Props & { assetId: string; current: AssetCondition }) {
  const [condition, setCondition] = useState<AssetCondition>(current);
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Record inspection"
      icon={<ClipboardCheckIcon />}
      title="Record an inspection"
      description={jobId ? "It is linked to the job this branch belongs to." : undefined}
      submitLabel="Record"
      success="Inspection recorded"
      onSubmit={async () => {
        const result = await recordCondition({ branch, assetId, condition, note, jobId });
        if (result.error === null) toast.message(describeOutcome(result.data.outcome, result.data.linked));
        return result;
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="inspect-condition">Condition found</Label>
        <FieldSelect id="inspect-condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} placeholder="Condition" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="inspect-note">Note (optional)</Label>
        <Textarea id="inspect-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function Operate({ valve, branch, jobId }: Props & { valve: NodeDto }) {
  const [isOpen, setIsOpen] = useState(valve.isOpen !== true);
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label="Operate valve"
      icon={<ToggleLeftIcon />}
      title={`Operate ${valve.name}`}
      description="Records that the valve was opened or closed, and brings its state on this branch into line."
      submitLabel="Record"
      success="Valve operation recorded"
      onSubmit={async () => {
        const result = await recordValveOperation({ branch, valveId: valve.id, isOpen, note, jobId });
        if (result.error === null) toast.message(describeOutcome(result.data.outcome, result.data.linked));
        return result;
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="valve-state">Now</Label>
        <FieldSelect
          id="valve-state"
          value={isOpen ? "open" : "closed"}
          onChange={(v) => setIsOpen(v === "open")}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
          placeholder="State"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="valve-note">Note (optional)</Label>
        <Textarea id="valve-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
      </div>
    </ActionDialog>
  );
}

function EditNode({ node, branch }: { node: NodeDto; branch: string }) {
  const [name, setName] = useState(node.name);
  const [condition, setCondition] = useState<AssetCondition>(node.condition);
  return (
    <ActionDialog
      label="Edit"
      icon={<PencilIcon />}
      title={`Edit ${node.name}`}
      submitLabel="Save"
      success="Node saved"
      canSubmit={name.trim() !== ""}
      onSubmit={() =>
        updateNode({
          branch,
          id: node.id,
          baseVersionId: node.versionId,
          patch: { ...(name.trim() !== node.name ? { name: name.trim() } : {}), ...(condition !== node.condition ? { condition } : {}) },
        })
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="edit-node-name">Name</Label>
        <Input id="edit-node-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-node-condition">Condition</Label>
        <FieldSelect id="edit-node-condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} placeholder="Condition" />
      </div>
    </ActionDialog>
  );
}

function EditPipe({ pipe, branch }: { pipe: PipeDto; branch: string }) {
  const [material, setMaterial] = useState<PipeMaterial>(pipe.material);
  const [diameter, setDiameter] = useState(String(pipe.diameterMm));
  const [condition, setCondition] = useState<AssetCondition>(pipe.condition);
  const diameterMm = Number(diameter);
  return (
    <ActionDialog
      label="Edit"
      icon={<PencilIcon />}
      title="Edit this pipe"
      description="Its end nodes are fixed. To reconnect it, delete it and draw a new one."
      submitLabel="Save"
      success="Pipe saved"
      canSubmit={Number.isFinite(diameterMm) && diameterMm > 0}
      onSubmit={() =>
        updatePipe({
          branch,
          id: pipe.id,
          baseVersionId: pipe.versionId,
          patch: {
            ...(material !== pipe.material ? { material } : {}),
            ...(diameterMm !== pipe.diameterMm ? { diameterMm } : {}),
            ...(condition !== pipe.condition ? { condition } : {}),
          },
        })
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="edit-pipe-material">Material</Label>
        <FieldSelect id="edit-pipe-material" value={material} onChange={(v) => setMaterial(v as PipeMaterial)} options={PIPE_MATERIALS.map((m) => ({ value: m, label: materialLabel[m] ?? m }))} placeholder="Material" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-pipe-diameter">Diameter (mm)</Label>
        <Input id="edit-pipe-diameter" type="number" min={1} max={5000} value={diameter} onChange={(e) => setDiameter(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="edit-pipe-condition">Condition</Label>
        <FieldSelect id="edit-pipe-condition" value={condition} onChange={(v) => setCondition(v as AssetCondition)} options={conditionOptions} placeholder="Condition" />
      </div>
    </ActionDialog>
  );
}

interface Impact {
  blockers: string[];
  warnings: string[];
  openJobs: unknown[];
}

function Remove({ kind, id, versionId, name, branch, onDone }: { kind: "node" | "pipe"; id: string; versionId: string; name: string; branch: string; onDone: () => void }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  return (
    <ActionDialog
      label="Delete"
      icon={<Trash2Icon />}
      variant="destructive"
      title={`Delete ${name}`}
      description="Deleting is recorded and can be undone on the live network by restoring it."
      submitLabel="Delete"
      success="Deleted"
      canSubmit={impact === null || impact.blockers.length === 0}
      onOpen={async () => {
        setImpact(null);
        const result = await deleteImpact({ kind, id });
        if (result.error === null) setImpact(result.data);
      }}
      onSubmit={async () => {
        const result = await deleteAsset({ kind, id, baseVersionId: versionId, branch });
        if (result.error === null) onDone();
        return result;
      }}
    >
      {impact === null ? (
        <p className="text-sm text-muted-foreground">Checking what depends on it...</p>
      ) : (
        <div className="grid gap-2 text-sm">
          {impact.blockers.map((b) => (
            <p key={b} className="rounded-lg bg-destructive/10 p-2 text-destructive">
              {b}
            </p>
          ))}
          {impact.warnings.map((w) => (
            <p key={w} className="rounded-lg bg-warning/12 p-2 text-warning">
              {w}
            </p>
          ))}
          {impact.openJobs.length > 0 && <Badge variant="warning">{impact.openJobs.length} open {impact.openJobs.length === 1 ? "job refers" : "jobs refer"} to it</Badge>}
          {impact.blockers.length === 0 && impact.warnings.length === 0 && <p className="text-muted-foreground">Nothing else depends on it.</p>}
        </div>
      )}
    </ActionDialog>
  );
}
