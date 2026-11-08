"use client";

import type { NodeType } from "@flowless/shared-types";
import { Checkbox } from "@/components/ui/checkbox";
import { CONDITION_HEX, conditionLabel, CONNECTION_HEX, NODE_TYPE_LABEL, NODE_TYPES, STRUCTURE_HEX } from "./map-config";

function Toggle({ checked, onChange, children, swatch }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; swatch?: React.ReactNode }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-1 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {swatch}
      {children}
    </label>
  );
}

export function LayersPanel({
  visibleTypes,
  onToggleType,
  showStructures,
  onShowStructures,
  showConnections,
  onShowConnections,
  forceConnections,
}: {
  visibleTypes: ReadonlySet<NodeType>;
  onToggleType: (type: NodeType) => void;
  showStructures: boolean;
  onShowStructures: (show: boolean) => void;
  showConnections: boolean;
  onShowConnections: (show: boolean) => void;
  /** A simulated break always shows who it reaches. */
  forceConnections: boolean;
}) {
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-0.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Show</legend>
        {NODE_TYPES.map((type) => (
          <Toggle key={type} checked={visibleTypes.has(type)} onChange={() => onToggleType(type)}>
            {NODE_TYPE_LABEL[type]}
          </Toggle>
        ))}
        <Toggle checked={showStructures} onChange={onShowStructures} swatch={<span className="size-3 rounded-full border-2 bg-white" style={{ borderColor: STRUCTURE_HEX }} aria-hidden />}>
          Structures
        </Toggle>
        <Toggle
          checked={showConnections || forceConnections}
          onChange={onShowConnections}
          swatch={<span className="size-3 rounded-full" style={{ background: CONNECTION_HEX.normal }} aria-hidden />}
        >
          Service connections
        </Toggle>
      </fieldset>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Condition</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {(Object.keys(CONDITION_HEX) as (keyof typeof CONDITION_HEX)[]).map((c) => (
            <li key={c} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: CONDITION_HEX[c] }} aria-hidden />
              {conditionLabel[c]}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Thicker lines are larger pipes. Valves, meters and hydrants are drawn larger than junctions.</p>
      </div>
    </div>
  );
}
