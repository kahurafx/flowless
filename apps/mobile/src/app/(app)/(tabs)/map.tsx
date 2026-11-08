import { NODE_TYPES, type NodeType } from "@flowless/shared-types";
import { affectedConnections, traceDirectional, traceIsolation, tracePipeIds, traceSubnetworkMembership } from "@flowless/network";
import { useRouter } from "expo-router";
import { Layers, LocateFixed, Navigation, Route as RouteIcon, Search, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { caption, NODE_TYPE_COLOR, TypeTile } from "../../../components/asset-row";
import { MapLayersSheet, type ColorMode } from "../../../components/map-layers-sheet";
import { MapTracePanel, type TraceMode, type TraceResult } from "../../../components/map-trace-panel";
import { NetworkMap, type MapHandle } from "../../../components/network-map";
import { Button, Card, Chip, ConditionBadge, Divider, IconButton, StatusPill, Text, TextInput } from "../../../components/ui";
import { approxMetres, NODE_TYPE_PLURAL } from "../../../lib/format";
import { openDirections } from "../../../lib/directions";
import { useLocation } from "../../../lib/location";
import { SUBNETWORK_PALETTE, TRACE_HEX } from "../../../lib/map-style";
import { radius, useTheme } from "../../../lib/theme";
import { useNetwork, useSync, useToast } from "../../../state/app";

const shadow = { shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6 } as const;

export default function MapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const { nodes, pipes, connections, dmas, subnetworks: subnetworkList } = useNetwork();
  const { online, pending } = useSync();
  const showToast = useToast();
  const { status: gpsStatus, point, request, refresh } = useLocation();
  const mapRef = useRef<MapHandle>(null);

  const [filter, setFilter] = useState<"all" | NodeType>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDmaId, setSelectedDmaId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("condition");
  const [showDmas, setShowDmas] = useState(true);
  const [showPipes, setShowPipes] = useState(true);
  const [showConnections, setShowConnections] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [query, setQuery] = useState("");

  const [traceMode, setTraceMode] = useState<TraceMode | null>(null);
  const [traceStart, setTraceStart] = useState<string | null>(null); // a node id, or a pipe id in isolation mode
  const [skipIds, setSkipIds] = useState<string[]>([]);

  const [panelH, setPanelH] = useState(48);

  // Layout: a line of map credit at the bottom, then whatever panel is showing above it.
  const bottomBase = 32;
  const padding = { top: insets.top + 150, bottom: bottomBase + panelH + 24 };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const dma = dmas.find((d) => d.id === selectedDmaId) ?? null;

  /* ---------- derived: trace, DMA, subnetwork colours ---------- */

  const trace = useMemo<TraceResult | null>(() => {
    if (!traceMode || !traceStart) return null;
    if (traceMode === "isolation") {
      const r = traceIsolation(traceStart, nodes, pipes, skipIds);
      return {
        affected: r.affectedNodes,
        valvesToClose: r.valvesToClose,
        alreadyClosed: r.alreadyClosed,
        deadEnds: r.unisolatedSources.length,
        customers: affectedConnections(traceStart, nodes, pipes, connections, skipIds),
      };
    }
    return { affected: traceDirectional(traceStart, traceMode, nodes, pipes), valvesToClose: [], alreadyClosed: [], deadEnds: 0 };
  }, [traceMode, traceStart, skipIds, nodes, pipes, connections]);

  const dmaTraced = useMemo(() => (dma?.inletMeterId ? traceDirectional(dma.inletMeterId, "downstream", nodes, pipes) : []), [dma, nodes, pipes]);
  const dmaOpenValves = useMemo(() => (dma ? dma.boundaryValveIds.filter((id) => nodes.find((n) => n.id === id)?.isOpen !== false) : []), [dma, nodes]);

  const subnetworks = useMemo(() => subnetworkList.map((s, i) => ({ ...s, color: SUBNETWORK_PALETTE[i % SUBNETWORK_PALETTE.length]! })), [subnetworkList]);
  const subnetworkColors = useMemo(() => {
    const byId: Record<string, string> = {};
    for (const s of subnetworks) for (const m of traceSubnetworkMembership(s.controllerNodeId, nodes, pipes)) if (!(m.id in byId)) byId[m.id] = s.color;
    return byId;
  }, [subnetworks, nodes, pipes]);

  const highlightIds = trace ? [...trace.affected, ...trace.valvesToClose].map((n) => n.id) : dmaTraced.map((n) => n.id);
  const warningIds = trace ? trace.valvesToClose.map((n) => n.id) : dmaOpenValves;
  const failedPipeId = traceMode === "isolation" ? traceStart : null;
  const affectedConnectionIds = useMemo(() => (trace?.customers ? [...trace.customers.onSection, ...trace.customers.alsoLosingSupply].map((x) => x.id) : []), [trace]);
  const directional = useMemo(() => {
    if (!trace || !traceStart || (traceMode !== "upstream" && traceMode !== "downstream")) return null;
    const nodeIds = trace.affected.map((n) => n.id);
    return { color: TRACE_HEX[traceMode], nodeIds, pipeIds: tracePipeIds(nodeIds, pipes), originId: traceStart };
  }, [trace, traceMode, traceStart, pipes]);

  // Frame whatever the trace or the selected DMA is about.
  useEffect(() => {
    if (trace && trace.affected.length) mapRef.current?.fitTo(trace.affected.map((n) => n.location));
  }, [trace]);
  useEffect(() => {
    if (dma) mapRef.current?.fitTo(dma.ring);
  }, [dma]);

  /* ---------- interactions ---------- */

  function onNodePress(id: string) {
    if (traceMode === "upstream" || traceMode === "downstream") return setTraceStart(id);
    if (traceMode === "isolation") return;
    setSelectedDmaId(null);
    setSelectedId(id);
  }
  function onPipePress(id: string) {
    if (traceMode === "isolation") {
      setTraceStart(id);
      setSkipIds([]);
    }
  }
  function onDmaPress(id: string) {
    if (traceMode) return;
    setSelectedId(null);
    setSelectedDmaId((prev) => (prev === id ? null : id));
  }
  function onBackground() {
    Keyboard.dismiss();
    if (!traceMode) {
      setSelectedId(null);
      setSelectedDmaId(null);
    }
  }
  function startTrace() {
    setTraceMode("isolation");
    setTraceStart(null);
    setSkipIds([]);
    setSelectedId(null);
    setSelectedDmaId(null);
  }
  function clearTrace() {
    setTraceMode(null);
    setTraceStart(null);
    setSkipIds([]);
  }
  function changeTraceMode(m: TraceMode) {
    setTraceMode(m);
    setTraceStart(null);
    setSkipIds([]);
  }

  async function locate() {
    if (gpsStatus !== "granted" && !(await request())) {
      showToast("Location is off. Turn it on in Settings to see where you are.");
      return;
    }
    const fix = await refresh();
    const here = fix?.point ?? point;
    if (here) mapRef.current?.flyTo(here, 16);
    else showToast("Couldn't get a GPS fix yet");
  }

  const q = query.trim().toLowerCase();
  const results = q ? nodes.filter((n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).slice(0, 5) : [];
  const visibleCount = nodes.filter((n) => filter === "all" || n.type === filter).length;
  const distance = selected && point ? Math.round(approxMetres(point, selected.location)) : null;

  const panel = { gap: 12, borderRadius: radius["3xl"], borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16, ...shadow } as const;

  return (
    <View style={{ flex: 1, backgroundColor: c.muted }}>
      <NetworkMap
        ref={mapRef}
        nodes={nodes}
        pipes={pipes}
        dmas={dmas}
        selectedId={selectedId}
        selectedDmaId={selectedDmaId}
        filter={filter}
        colorMode={colorMode}
        subnetworkColors={subnetworkColors}
        showPipes={showPipes}
        showDmas={showDmas}
        highlightIds={highlightIds}
        warningIds={warningIds}
        failedPipeId={failedPipeId}
        trace={directional}
        connections={connections}
        showConnections={showConnections || traceMode === "isolation"}
        affectedConnectionIds={affectedConnectionIds}
        showUserLocation={gpsStatus === "granted"}
        padding={padding}
        onNodePress={onNodePress}
        onPipePress={onPipePress}
        onDmaPress={onDmaPress}
        onBackgroundPress={onBackground}
      />

      {/* Top: search, status, filters */}
      <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12, gap: 8 }}>
        <View style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius["2xl"], borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 14, ...shadow }}>
          <Search size={18} color={c.mutedForeground} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search assets or IDs" autoCorrect={false} style={{ flex: 1, minHeight: 44 }} />
          {query ? (
            <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} style={{ minHeight: 44, justifyContent: "center" }}>
              <X size={18} color={c.mutedForeground} />
            </Pressable>
          ) : null}
        </View>

        {q ? (
          <Card style={{ overflow: "hidden", ...shadow }}>
            {results.length === 0 ? (
              <Text tone="muted" style={{ padding: 16 }}>
                No asset matches “{query.trim()}”.
              </Text>
            ) : (
              results.map((n, i) => (
                <View key={n.id}>
                  {i > 0 && <Divider />}
                  <Pressable
                    onPress={() => {
                      Keyboard.dismiss();
                      setQuery("");
                      setSelectedDmaId(null);
                      setSelectedId(n.id);
                      mapRef.current?.flyTo(n.location);
                    }}
                    accessibilityRole="button"
                    style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 }}
                  >
                    <TypeTile type={n.type} size={36} />
                    <Text numberOfLines={1} style={{ flex: 1 }}>
                      {n.name}
                    </Text>
                    <ConditionBadge condition={n.condition} />
                  </Pressable>
                </View>
              ))
            )}
          </Card>
        ) : (
          <>
            {(!online || pending > 0) && <StatusPill tone={online ? "info" : "warn"} label={online ? `${pending} changes to upload` : `Offline · ${pending} pending`} onPress={() => router.push("/sync")} />}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 12 }}>
              <Chip label="All" active={filter === "all"} onPress={() => setFilter("all")} />
              {NODE_TYPES.map((t) => (
                <Chip key={t} label={NODE_TYPE_PLURAL[t]} dot={NODE_TYPE_COLOR[t]} active={filter === t} onPress={() => setFilter(t)} />
              ))}
            </ScrollView>
          </>
        )}
      </View>

      {/* Controls ride above whichever panel is showing */}
      <View pointerEvents="box-none" style={{ position: "absolute", right: 12, bottom: bottomBase + panelH + 12, gap: 10 }}>
        <IconButton icon={Layers} label="Map layers" onPress={() => setLayersOpen(true)} />
        <IconButton icon={RouteIcon} label="Trace" active={!!traceMode} onPress={traceMode ? clearTrace : startTrace} />
        <IconButton icon={LocateFixed} label="My location" onPress={locate} />
      </View>

      {/* Bottom panel: trace > DMA > selected asset > count */}
      <View pointerEvents="box-none" onLayout={(e) => setPanelH(e.nativeEvent.layout.height)} style={{ position: "absolute", left: 12, right: 12, bottom: bottomBase }}>
        {traceMode ? (
          <MapTracePanel mode={traceMode} onMode={changeTraceMode} result={trace} onSkip={(id) => setSkipIds((s) => [...s, id])} onClear={clearTrace} onOpen={(id) => router.push({ pathname: "/asset/[id]", params: { id } })} />
        ) : dma ? (
          <View style={{ ...panel, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dma.color }} />
              <Text bold style={{ flex: 1 }}>
                {dma.name}
              </Text>
              <Pressable onPress={() => setSelectedDmaId(null)} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                <X size={20} color={c.mutedForeground} />
              </Pressable>
            </View>
            <Text v="small" tone="muted">
              {dmaTraced.length} assets fed from its inlet meter
              {dmaOpenValves.length > 0 ? ` · ${dmaOpenValves.length} boundary valve${dmaOpenValves.length === 1 ? "" : "s"} not confirmed closed` : " · sealed"}
            </Text>
          </View>
        ) : selected ? (
          <View style={panel}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <TypeTile type={selected.type} size={48} />
              <View style={{ flex: 1 }}>
                <Text bold numberOfLines={1}>
                  {selected.name}
                </Text>
                <Text v="small" tone="muted" numberOfLines={1}>
                  {distance !== null ? `${distance < 1000 ? `${distance} m` : `${(distance / 1000).toFixed(1)} km`} away · ` : ""}
                  {caption(selected).split(" · ")[1] ?? ""}
                </Text>
              </View>
              <ConditionBadge condition={selected.condition} />
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button label="Directions" icon={Navigation} compact onPress={() => openDirections(selected.location, selected.name)} style={{ flex: 1 }} />
              <Button label="Details" variant="secondary" compact onPress={() => router.push({ pathname: "/asset/[id]", params: { id: selected.id } })} style={{ flex: 1 }} />
            </View>
          </View>
        ) : (
          <View style={{ alignSelf: "center", borderRadius: radius.full, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 20, paddingVertical: 12, ...shadow }}>
            <Text v="small" bold>
              {visibleCount} assets
            </Text>
          </View>
        )}
      </View>

      {/* Basemap credit, required by the CARTO and OpenStreetMap styles */}
      <View pointerEvents="none" style={{ position: "absolute", left: 12, bottom: 6, borderRadius: 4, backgroundColor: c.card + "CC", paddingHorizontal: 6, paddingVertical: 2 }}>
        <Text v="caption" tone="muted">
          © OpenStreetMap contributors © CARTO
        </Text>
      </View>

      <MapLayersSheet
        visible={layersOpen}
        onClose={() => setLayersOpen(false)}
        colorMode={colorMode}
        onColorMode={setColorMode}
        showDmas={showDmas}
        onShowDmas={setShowDmas}
        showPipes={showPipes}
        onShowPipes={setShowPipes}
        showConnections={showConnections}
        onShowConnections={setShowConnections}
        subnetworks={subnetworks}
      />
    </View>
  );
}
