"use client";

import { affectedConnections, dmaMembership, tracePipeIds, traceDirectional, traceIsolation } from "@flowless/network";
import type { NodeType } from "@flowless/shared-types";
import { CheckIcon, CircleDotIcon, MousePointer2Icon, Spline, Undo2Icon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NetworkMapData } from "@/data/gis";
import { useResolvedTheme } from "@/lib/use-resolved-theme";
import { updateDma, updateNode } from "./actions";
import { AssetPanel, type Selection } from "./asset-panel";
import { BranchBar } from "./branch-bar";
import { NewNodeDialog, NewPipeDialog, type PipeDraft } from "./create-dialogs";
import { DmaPanel, NewDmaDialog, type DrawPurpose } from "./dma-panel";
import type { LatLng } from "./geojson";
import { LayersPanel } from "./layers-panel";
import { NODE_TYPES, type Tool, type TraceMode } from "./map-config";
import { TracePanel, type TraceResult } from "./trace-panel";
import { useNetworkMap, type MapClick, type MapState } from "./use-network-map";

type PanelTab = "layers" | "trace" | "dmas" | "asset";
interface TraceStart {
  mode: TraceMode;
  startNodeId?: string;
  failedPipeId?: string;
  skipValveIds: string[];
}

/** The network map (G-01 to G-03): branch chooser, edit tools that save, traces and DMA membership. */
export function NetworkMap({ data }: { data: NetworkMapData }) {
  const { branch, nodes, pipes, structures, connections, dmas, tiers, can } = data;
  const dark = useResolvedTheme() === "dark";
  const container = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<PanelTab>(data.initialDmaId ? "dmas" : "layers");
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<ReadonlySet<NodeType>>(new Set(NODE_TYPES));
  const [showStructures, setShowStructures] = useState(true);
  const [showConnections, setShowConnections] = useState(false);
  const [selectedDmaId, setSelectedDmaId] = useState<string | null>(data.initialDmaId);
  const [isolatedDmaId, setIsolatedDmaId] = useState<string | null>(data.initialDmaId);
  const [traceMode, setTraceMode] = useState<TraceMode | null>(null);
  const [trace, setTrace] = useState<TraceStart | null>(null);

  // Drawing and placing.
  const [newNodeAt, setNewNodeAt] = useState<LatLng | null>(null);
  const [pipeFrom, setPipeFrom] = useState<string | null>(null);
  const [pipeVertices, setPipeVertices] = useState<LatLng[]>([]);
  const [pipeDraft, setPipeDraft] = useState<PipeDraft | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [dmaDraw, setDmaDraw] = useState<{ purpose: DrawPurpose; points: LatLng[] } | null>(null);
  const [dmaRing, setDmaRing] = useState<LatLng[] | null>(null);

  const writable = branch === "main" ? can.post : can.edit;
  const why = !can.edit && !can.post ? "You can view the network but not change it." : branch === "main" && !can.post ? "The live network is changed by posting a branch. Switch to your field branch or a job's branch to propose edits." : null;
  const jobId = data.job && data.job.branch === branch ? data.job.id : undefined;

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Traces run on the branch as loaded: the same @flowless/network functions the server runs.
  const traceResult = useMemo<TraceResult | null>(() => {
    if (!trace) return null;
    if (trace.mode === "isolation" && trace.failedPipeId) {
      const r = traceIsolation(trace.failedPipeId, nodes, pipes, trace.skipValveIds);
      return {
        mode: "isolation",
        affected: r.affectedNodes,
        valvesToClose: r.valvesToClose,
        alreadyClosed: r.alreadyClosed,
        unisolatedSources: r.unisolatedSources.length,
        customers: affectedConnections(trace.failedPipeId, nodes, pipes, connections, trace.skipValveIds),
      };
    }
    if ((trace.mode === "upstream" || trace.mode === "downstream") && trace.startNodeId) {
      return { mode: trace.mode, affected: traceDirectional(trace.startNodeId, trace.mode, nodes, pipes), valvesToClose: [], alreadyClosed: [], unisolatedSources: 0, customers: null };
    }
    return null;
  }, [trace, nodes, pipes, connections]);

  const selectedDma = dmas.find((d) => d.id === selectedDmaId) ?? null;
  const membership = useMemo(
    () => (selectedDma?.inletMeterId ? dmaMembership({ inletMeterId: selectedDma.inletMeterId, ring: selectedDma.ring, boundaryValveIds: selectedDma.boundaryValveIds }, nodes, pipes) : null),
    [selectedDma, nodes, pipes],
  );
  const isolated = useMemo(
    () => (membership && isolatedDmaId && isolatedDmaId === selectedDmaId ? { dmaId: isolatedDmaId, nodeIds: membership.memberIds, pipeIds: tracePipeIds(membership.memberIds, pipes) } : null),
    [membership, isolatedDmaId, selectedDmaId, pipes],
  );

  const drawing: MapState["drawing"] = dmaDraw
    ? { kind: "dma", points: dmaDraw.points }
    : tool === "draw-pipe" && pipeFrom
      ? { kind: "pipe", points: [nodeById.get(pipeFrom)!.location, ...pipeVertices] }
      : null;

  const fit = useMemo<MapState["fit"]>(() => {
    if (traceResult && trace) {
      return { key: `trace:${trace.startNodeId ?? trace.failedPipeId}:${trace.skipValveIds.length}`, points: traceResult.affected.map((n) => n.location), maxZoom: 17 };
    }
    if (selectedDma && membership) {
      return { key: `dma:${selectedDma.id}`, points: [...selectedDma.ring, ...membership.memberIds.flatMap((id) => nodeById.get(id)?.location ?? [])] };
    }
    return { key: `all:${branch}`, points: [...nodes.map((n) => n.location), ...structures.map((s) => s.location), ...pipes.flatMap((p) => p.path)], maxZoom: 16 };
  }, [traceResult, trace, selectedDma, membership, nodeById, nodes, structures, pipes, branch]);

  const state: MapState = {
    dark,
    nodes,
    pipes,
    structures,
    connections,
    dmas,
    visibleTypes,
    showStructures,
    showConnections: showConnections || traceMode === "isolation",
    isolated,
    selectedDmaId,
    trace: traceResult ? { mode: traceResult.mode, nodes: traceResult.affected, startNodeId: trace?.startNodeId, failedPipeId: trace?.failedPipeId } : null,
    emphasis: traceResult
      ? { ids: traceResult.affected.map((n) => n.id), warningIds: traceResult.valvesToClose.map((n) => n.id) }
      : membership
        ? { ids: membership.memberIds, warningIds: [...membership.openBoundaryValveIds, ...membership.outsideBoundary] }
        : null,
    affectedConnectionIds: traceResult?.customers ? [...traceResult.customers.onSection, ...traceResult.customers.alsoLosingSupply].map((c) => c.id) : [],
    selected: selection,
    drawing,
    crosshair: tool !== "select" || dmaDraw !== null || traceMode !== null,
    fit,
  };

  const chooseTool = (next: Tool) => {
    setTool(next);
    setPipeFrom(null);
    setPipeVertices([]);
    setMoveId(null);
    setDmaDraw(null);
    if (next !== "select") {
      setTraceMode(null);
      setTrace(null);
    }
  };

  const select = (kind: Selection["kind"], id: string) => {
    setSelection({ kind, id });
    setTab("asset");
  };

  const onClick = (click: MapClick) => {
    // A DMA's shaded area is only something to click while selecting; when placing or drawing it is empty ground.
    const f = click.feature?.kind === "dma" && tool !== "select" ? null : click.feature;
    if (dmaDraw) {
      setDmaDraw({ ...dmaDraw, points: [...dmaDraw.points, click.point] });
      return;
    }
    if (tool === "add-node") {
      if (!f) setNewNodeAt(click.point);
      return;
    }
    if (tool === "move-node" && moveId) {
      const node = nodeById.get(moveId);
      setMoveId(null);
      setTool("select");
      if (!node) return;
      void updateNode({ branch, id: node.id, baseVersionId: node.versionId, patch: { location: click.point } }).then((r) =>
        r.error === null ? toast.success(`${node.name} moved`) : toast.error(r.error),
      );
      return;
    }
    if (tool === "draw-pipe") {
      if (f?.kind === "node") {
        if (!pipeFrom) {
          setPipeFrom(f.id);
          return;
        }
        if (f.id === pipeFrom) return;
        const from = nodeById.get(pipeFrom)!;
        const to = nodeById.get(f.id)!;
        setPipeDraft({ fromNodeId: from.id, toNodeId: to.id, fromName: from.name, toName: to.name, path: [from.location, ...pipeVertices, to.location] });
      } else if (pipeFrom && !f) {
        setPipeVertices((v) => [...v, click.point]);
      }
      return;
    }
    // Select tool.
    if (traceMode === "upstream" || traceMode === "downstream") {
      if (f?.kind === "node") setTrace({ mode: traceMode, startNodeId: f.id, skipValveIds: [] });
      return;
    }
    if (traceMode === "isolation") {
      if (f?.kind === "pipe") setTrace({ mode: "isolation", failedPipeId: f.id, skipValveIds: [] });
      return;
    }
    if (f?.kind === "dma") {
      setSelectedDmaId(f.id === selectedDmaId ? null : f.id);
      setTab("dmas");
    } else if (f) select(f.kind, f.id);
    else setSelection(null);
  };

  useNetworkMap(container, state, onClick, data.center);

  const startDma = (purpose: DrawPurpose) => {
    chooseTool("draw-dma");
    setDmaDraw({ purpose, points: [] });
    toast.message(`Click the map to outline ${purpose.name}, then choose Finish.`);
  };

  const finishDma = async () => {
    if (!dmaDraw || dmaDraw.points.length < 3) return;
    const { purpose, points } = dmaDraw;
    if (purpose.type === "create") {
      setDmaRing(points);
      return;
    }
    const dma = dmas.find((d) => d.id === purpose.dmaId);
    if (!dma) return;
    const result = await updateDma({ branch, id: dma.id, baseVersionId: dma.versionId, patch: { ring: points } });
    if (result.error !== null) toast.error(result.error);
    else {
      toast.success(`${purpose.name} boundary saved`);
      chooseTool("select");
    }
  };

  const clearTrace = () => {
    setTraceMode(null);
    setTrace(null);
  };
  const selectTraceMode = (mode: TraceMode) => {
    setTraceMode(traceMode === mode ? null : mode);
    setTrace(null);
    if (tool !== "select") chooseTool("select");
    setSelectedDmaId(null);
    setIsolatedDmaId(null);
  };

  const toolHint = dmaDraw
    ? `Outlining ${dmaDraw.purpose.name}: ${dmaDraw.points.length} ${dmaDraw.points.length === 1 ? "corner" : "corners"}. At least three, then Finish.`
    : tool === "add-node"
      ? "Click an empty spot on the map to place a node."
      : tool === "move-node"
        ? `Click where ${moveId ? (nodeById.get(moveId)?.name ?? "the node") : "the node"} should go.`
        : tool === "draw-pipe"
          ? pipeFrom
            ? `From ${nodeById.get(pipeFrom)?.name ?? "a node"}: click the map to bend the pipe, or click the end node.`
            : "Click the node the pipe starts at."
          : null;

  return (
    <div className="grid gap-3">
      <BranchBar branch={branch} choices={data.branches} job={data.job} canPost={can.post} writable={writable} why={why} />

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Map tools">
        <Button variant={tool === "select" ? "default" : "outline"} aria-pressed={tool === "select"} onClick={() => chooseTool("select")}>
          <MousePointer2Icon />
          Select
        </Button>
        {writable && (
          <>
            <Button variant={tool === "add-node" ? "default" : "outline"} aria-pressed={tool === "add-node"} onClick={() => chooseTool(tool === "add-node" ? "select" : "add-node")}>
              <CircleDotIcon />
              Add node
            </Button>
            <Button variant={tool === "draw-pipe" ? "default" : "outline"} aria-pressed={tool === "draw-pipe"} onClick={() => chooseTool(tool === "draw-pipe" ? "select" : "draw-pipe")}>
              <Spline />
              Draw pipe
            </Button>
          </>
        )}
        {dmaDraw && (
          <>
            <Button disabled={dmaDraw.points.length < 3} onClick={finishDma}>
              <CheckIcon />
              Finish
            </Button>
            <Button variant="outline" disabled={dmaDraw.points.length === 0} onClick={() => setDmaDraw({ ...dmaDraw, points: dmaDraw.points.slice(0, -1) })}>
              <Undo2Icon />
              Undo corner
            </Button>
          </>
        )}
        {tool === "draw-pipe" && pipeVertices.length > 0 && (
          <Button variant="outline" onClick={() => setPipeVertices((v) => v.slice(0, -1))}>
            <Undo2Icon />
            Undo bend
          </Button>
        )}
        {tool !== "select" && (
          <Button variant="ghost" onClick={() => chooseTool("select")}>
            <XIcon />
            Cancel
          </Button>
        )}
        {toolHint && (
          <p className="text-sm text-muted-foreground" role="status">
            {toolHint}
          </p>
        )}
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative h-[60dvh] min-h-80 overflow-hidden rounded-xl border bg-muted lg:h-[calc(100dvh-14rem)]">
          <div ref={container} className="size-full" aria-label="Network map" role="application" />
        </div>
        <div className="rounded-xl border bg-card p-3 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto">
          <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="layers">Layers</TabsTrigger>
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value="dmas">DMAs</TabsTrigger>
              <TabsTrigger value="asset">Asset</TabsTrigger>
            </TabsList>
            <TabsContent value="layers" className="pt-3">
              <LayersPanel
                visibleTypes={visibleTypes}
                onToggleType={(type) => setVisibleTypes((prev) => new Set(prev.has(type) ? [...prev].filter((t) => t !== type) : [...prev, type]))}
                showStructures={showStructures}
                onShowStructures={setShowStructures}
                showConnections={showConnections}
                onShowConnections={setShowConnections}
                forceConnections={traceMode === "isolation"}
              />
            </TabsContent>
            <TabsContent value="trace" className="pt-3">
              <TracePanel
                mode={traceMode}
                result={traceResult}
                onMode={selectTraceMode}
                onSkip={(valveId) => trace && setTrace({ ...trace, skipValveIds: [...trace.skipValveIds, valveId] })}
                onClear={clearTrace}
                onSelectNode={(id) => select("node", id)}
              />
            </TabsContent>
            <TabsContent value="dmas" className="pt-3">
              <DmaPanel
                dmas={dmas}
                undrawn={data.undrawnDmas}
                nodes={nodes}
                branch={branch}
                writable={writable}
                selectedId={selectedDmaId}
                membership={membership}
                isolatedId={isolatedDmaId}
                drawing={dmaDraw?.purpose ?? null}
                onSelect={(id) => {
                  setSelectedDmaId(id);
                  setIsolatedDmaId(null);
                  if (id) clearTrace();
                }}
                onIsolate={setIsolatedDmaId}
                onDraw={startDma}
              />
            </TabsContent>
            <TabsContent value="asset" className="pt-3">
              <AssetPanel
                selection={selection}
                nodes={nodes}
                pipes={pipes}
                structures={structures}
                connections={connections}
                branch={branch}
                writable={writable}
                canLog={can.edit}
                canDelete={can.remove}
                jobId={jobId}
                locale={data.locale}
                timeZone={data.timeZone}
                onMove={(id) => {
                  setMoveId(id);
                  setTool("move-node");
                }}
                onClear={() => setSelection(null)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <NewNodeDialog branch={branch} at={newNodeAt} onClose={() => setNewNodeAt(null)} />
      <NewPipeDialog
        branch={branch}
        draft={pipeDraft}
        onClose={() => {
          setPipeDraft(null);
          setPipeFrom(null);
          setPipeVertices([]);
        }}
      />
      <NewDmaDialog
        branch={branch}
        purpose={dmaDraw?.purpose.type === "create" ? dmaDraw.purpose : null}
        ring={dmaRing}
        nodes={nodes}
        tiers={tiers}
        onClose={() => {
          setDmaRing(null);
          chooseTool("select");
        }}
      />
    </div>
  );
}
