"use client";

import type { AffectedConnections } from "@flowless/network";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectionDto, NodeDto } from "@/data/gis";
import { TRACE_HEX, type TraceMode } from "./map-config";

export interface TraceResult {
  mode: TraceMode;
  affected: readonly NodeDto[];
  valvesToClose: readonly NodeDto[];
  alreadyClosed: readonly NodeDto[];
  unisolatedSources: number;
  customers: AffectedConnections<ConnectionDto> | null;
}

const MODES: { mode: TraceMode; label: string; hint: string }[] = [
  { mode: "upstream", label: "Upstream", hint: "Click a node to see what feeds it." },
  { mode: "downstream", label: "Downstream", hint: "Click a node to see what it feeds." },
  { mode: "isolation", label: "Isolation", hint: "Click a pipe to simulate a break there." },
];

export function TracePanel({
  mode,
  result,
  onMode,
  onSkip,
  onClear,
  onSelectNode,
}: {
  mode: TraceMode | null;
  result: TraceResult | null;
  onMode: (mode: TraceMode) => void;
  onSkip: (valveId: string) => void;
  onClear: () => void;
  onSelectNode: (id: string) => void;
}) {
  const hint = MODES.find((m) => m.mode === mode)?.hint;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Trace">
        {MODES.map((m) => (
          <Button key={m.mode} variant={mode === m.mode ? "default" : "outline"} aria-pressed={mode === m.mode} onClick={() => onMode(m.mode)} className="px-1.5">
            {m.label}
          </Button>
        ))}
      </div>
      {mode && !result && <p className="text-sm text-muted-foreground">{hint}</p>}
      {!mode && <p className="text-sm text-muted-foreground">Pick a trace, then click the map. Traces run on the network of the branch you are viewing.</p>}
      {(mode === "upstream" || mode === "downstream") && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-3 rounded-full" style={{ background: TRACE_HEX[mode] }} aria-hidden />
          {mode === "upstream" ? "Upstream" : "Downstream"} assets
          <span className="ml-2 size-3 rounded-full border-2" style={{ borderColor: "#facc15" }} aria-hidden />
          Start
        </p>
      )}
      {result && (
        <div className="grid gap-3 text-sm">
          <p>
            <span className="font-medium tabular">{result.affected.length}</span> {result.mode === "isolation" ? "assets lose supply" : result.affected.length === 1 ? "asset" : "assets"}
          </p>
          {result.customers && (
            <div className="grid gap-1.5">
              <p>
                <span className="font-medium tabular">{result.customers.onSection.length}</span> {result.customers.onSection.length === 1 ? "connection" : "connections"} on this section
                {result.customers.supplyKnown && (
                  <>
                    {" · "}
                    <span className="font-medium tabular">{result.customers.alsoLosingSupply.length}</span> also losing supply
                  </>
                )}
              </p>
              {!result.customers.supplyKnown && <p className="text-warning">No reservoir or pumping station is mapped, so who else loses supply can&apos;t be worked out.</p>}
              {result.customers.unlinkedCount > 0 && (
                <p className="text-warning">
                  {result.customers.unlinkedCount} {result.customers.unlinkedCount === 1 ? "connection isn't" : "connections aren't"} linked to a pipe, so can&apos;t be judged.
                </p>
              )}
              {result.customers.supplyKnown && <p className="text-xs text-muted-foreground">Based on what can still reach a source. Others may get low pressure.</p>}
            </div>
          )}
          {result.valvesToClose.length > 0 && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-muted-foreground">Valves to close</p>
              {result.valvesToClose.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-2">
                  <button type="button" className="min-h-9 text-left underline-offset-2 hover:underline" onClick={() => onSelectNode(v.id)}>
                    {v.name}
                  </button>
                  <Button variant="ghost" size="sm" onClick={() => onSkip(v.id)}>
                    Won&apos;t operate
                  </Button>
                </div>
              ))}
            </div>
          )}
          {result.alreadyClosed.length > 0 && <p className="text-xs text-muted-foreground">{result.alreadyClosed.length} valves are already closed and isolate the section.</p>}
          {result.unisolatedSources > 0 && (
            <p className="flex items-start gap-1.5 text-destructive">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              {result.unisolatedSources === 1 ? "A supply source is" : `${result.unisolatedSources} supply sources are`} connected to the break with no valve in between.
            </p>
          )}
          <ul className="max-h-40 overflow-y-auto rounded-lg border p-1" aria-label="Affected assets">
            {result.affected.map((n) => (
              <li key={n.id}>
                <button type="button" className="min-h-8 w-full truncate rounded-md px-2 text-left text-xs hover:bg-accent" onClick={() => onSelectNode(n.id)}>
                  {n.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(mode || result) && (
        <Button variant="outline" onClick={onClear}>
          Clear trace
        </Button>
      )}
    </div>
  );
}
