import {
  ASSET_CONDITIONS,
  DUPLICATE_RADIUS_M,
  JUNCTION_TYPES,
  NODE_PHOTO_RULE,
  NODE_TYPES,
  PIPE_MATERIALS,
  STRUCTURE_ATTACHMENT_RULES,
  STRUCTURE_TYPES,
  type AssetCondition,
  type JunctionType,
  type NodeType,
  type PipeMaterial,
  type StructureType,
} from "@flowless/shared-types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { AttachmentPicker } from "../../components/attachment-picker";
import { LocationCard } from "../../components/location-card";
import { NodePicker, SizeField } from "../../components/pickers";
import { Button, Card, Chip, Field, Footer, Header, Hint, Label, Screen, Segmented, Text } from "../../components/ui";
import { approxMetres, CONDITION_HEX, CONDITION_LABEL, describeJunction, JUNCTION_TYPE_HINT, JUNCTION_TYPE_LABEL, NODE_TYPE_LABEL, titleCase } from "../../lib/format";
import type { LatLng, LocalFile } from "../../lib/types";
import { useField, useJobs, useNetwork } from "../../state/app";

type Kind = "node" | "pipe" | "structure";

const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const outletLabel = (t: JunctionType) => (t === "elbow" || t === "reducer" ? "Outlet size (mm)" : "Branch size (mm)");
const materialLabel = (m: PipeMaterial) => (m === "pvc" || m === "hdpe" ? m.toUpperCase() : titleCase(m));

/**
 * One form for the three things a person can add. The rules shown here are the ones the server
 * enforces: only valves have an open/closed state, only some node types can be housed in some
 * structure types, a pipe needs two different existing nodes and its length comes from its path, and
 * a meter, reservoir or pumping station needs a photo before it can go live.
 */
export default function AddAsset() {
  const params = useLocalSearchParams<{ kind?: Kind; workOrderId?: string }>();
  const router = useRouter();
  const { nodes, structures } = useNetwork();
  const { addNode, addPipe, addStructure } = useField();
  const { workOrders, addJobAsset } = useJobs();
  const job = workOrders.find((o) => o.id === params.workOrderId);

  const [kind, setKind] = useState<Kind>(params.kind ?? "node");
  const [nodeType, setNodeType] = useState<NodeType>("valve");
  const [structureType, setStructureType] = useState<StructureType>("manhole");
  const [name, setName] = useState("");
  const [condition, setCondition] = useState<AssetCondition>("unknown");
  const [location, setLocation] = useState<LatLng | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [isOpen, setIsOpen] = useState<"open" | "closed" | "unknown">("unknown");
  const [structureId, setStructureId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  // Junction
  const [jType, setJType] = useState<JunctionType>("tee");
  const [mainSize, setMainSize] = useState("");
  const [reduced, setReduced] = useState(false);
  const [branchSize, setBranchSize] = useState("");
  // Pipe
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [material, setMaterial] = useState<PipeMaterial>("unknown");
  const [diameter, setDiameter] = useState("");

  const photoCount = files.filter((f) => f.kind === "photo").length;
  const isJunction = kind === "node" && nodeType === "junction";
  // A reducer always steps down, so "equal" doesn't apply to it.
  const isReduced = jType === "reducer" || reduced;
  const main = num(mainSize);
  const branch = num(branchSize);
  const photoRequired = kind === "node" && NODE_PHOTO_RULE[nodeType] === "required";

  const allowedStructures = useMemo(() => {
    const types = STRUCTURE_ATTACHMENT_RULES[nodeType];
    return structures.filter((s) => types.includes(s.type));
  }, [nodeType, structures]);

  const nearby = kind === "node" && location ? nodes.filter((n) => n.type === nodeType && !dismissed.includes(n.id) && approxMetres(n.location, location) <= DUPLICATE_RADIUS_M) : [];
  const dup = nearby[0];

  const from = nodes.find((n) => n.id === fromId);
  const to = nodes.find((n) => n.id === toId);
  const pipeLength = from && to ? Math.round(approxMetres(from.location, to.location)) : null;
  const sameEnds = !!fromId && fromId === toId;

  /** The first thing stopping a save, in plain words. Null means ready. */
  const issue: string | null = (() => {
    if (kind === "pipe") {
      if (!fromId || !toId) return "Choose both end nodes";
      if (sameEnds) return "Choose two different end nodes";
      if (!(num(diameter) > 0)) return "Enter the pipe diameter";
      return null;
    }
    if (!name.trim()) return "Enter a name";
    if (!location) return "Add the location";
    if (isJunction) {
      if (!(main > 0)) return "Enter the junction's pipe size";
      if (isReduced && !(branch > 0)) return `Enter the ${outletLabel(jType).toLowerCase()}`;
      if (isReduced && branch >= main) return "The smaller size must be less than the main size";
    }
    if (photoRequired && photoCount === 0) return "Add at least one photo";
    return null;
  })();

  function save() {
    if (issue) return;
    if (kind === "node") {
      addNode(
        {
          type: nodeType,
          name: name.trim(),
          location: location!,
          condition,
          isOpen: nodeType === "valve" ? (isOpen === "unknown" ? null : isOpen === "open") : null,
          structureId: allowedStructures.some((s) => s.id === structureId) ? structureId : null,
          junction: isJunction ? { type: jType, mainSizeMm: main, branchSizeMm: isReduced ? branch : null } : null,
          files,
        },
        params.workOrderId,
      );
    } else if (kind === "structure") {
      addStructure({ type: structureType, name: name.trim(), location: location!, condition, files }, params.workOrderId);
    } else {
      addPipe({ fromNodeId: fromId!, toNodeId: toId!, material, diameterMm: num(diameter), condition }, params.workOrderId);
    }
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Add asset" />
      {job && (
        <Card style={{ marginHorizontal: 16, padding: 14 }}>
          <Text v="small" tone="muted">
            Adding to {job.code}. It goes on this job&apos;s changes and is checked before it reaches the map.
          </Text>
        </Card>
      )}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          <Segmented<Kind>
            value={kind}
            onChange={(k) => {
              setKind(k);
              setFiles([]);
            }}
            options={[{ value: "node", label: "Node" }, { value: "pipe", label: "Pipe" }, { value: "structure", label: "Structure" }]}
          />

          {kind !== "pipe" && (
            <>
              <View style={{ gap: 8 }}>
                <Label>Type</Label>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {kind === "node"
                    ? NODE_TYPES.map((t) => (
                        <Chip
                          key={t}
                          label={NODE_TYPE_LABEL[t]}
                          active={nodeType === t}
                          onPress={() => {
                            setNodeType(t);
                            setStructureId(null);
                          }}
                        />
                      ))
                    : STRUCTURE_TYPES.map((t) => <Chip key={t} label={titleCase(t)} active={structureType === t} onPress={() => setStructureType(t)} />)}
                </View>
              </View>

              <Field label="Name" value={name} onChangeText={setName} placeholder={kind === "node" ? "e.g. Valve KLS-04" : "e.g. Manhole MH-13"} maxLength={200} />

              {isJunction && (
                <View style={{ gap: 16 }}>
                  <View style={{ gap: 8 }}>
                    <Label>Junction type</Label>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {JUNCTION_TYPES.map((t) => (
                        <Chip key={t} label={JUNCTION_TYPE_LABEL[t]} active={jType === t} onPress={() => setJType(t)} />
                      ))}
                    </View>
                    <Text v="small" tone="muted">
                      {JUNCTION_TYPE_HINT[jType]}
                    </Text>
                  </View>
                  <SizeField label="Pipe size (mm)" value={mainSize} onChange={setMainSize} />
                  {jType === "reducer" ? (
                    <Text v="small" tone="muted">
                      A reducer always steps down to a smaller size.
                    </Text>
                  ) : (
                    <View style={{ gap: 8 }}>
                      <Label>Sizes</Label>
                      <Segmented value={reduced ? "reduced" : "equal"} onChange={(v) => setReduced(v === "reduced")} options={[{ value: "equal", label: "Equal" }, { value: "reduced", label: "Reduced" }]} />
                    </View>
                  )}
                  {isReduced && <SizeField label={outletLabel(jType)} value={branchSize} onChange={setBranchSize} below={main > 0 ? main : undefined} />}
                  {main > 0 && (!isReduced || (branch > 0 && branch < main)) && (
                    <Card style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                      <Text bold>{describeJunction({ type: jType, mainSizeMm: main, branchSizeMm: isReduced ? branch : null })}</Text>
                    </Card>
                  )}
                </View>
              )}

              <View style={{ gap: 8 }}>
                <Label>Location</Label>
                <LocationCard value={location} onChange={setLocation} empty="No location yet. Stand at the asset and use your GPS position." />
              </View>

              {dup && location && (
                <Card style={{ gap: 12, borderColor: "#f59e0b", padding: 16 }}>
                  <Text bold>
                    {dup.name} is {Math.round(approxMetres(dup.location, location))} m away
                  </Text>
                  <Text v="small" tone="muted">
                    Is this the same {NODE_TYPE_LABEL[dup.type].toLowerCase()}?
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button
                      label="Same one"
                      variant="secondary"
                      compact
                      onPress={() => {
                        if (job) addJobAsset(job.id, dup.id);
                        router.back();
                      }}
                      style={{ flex: 1 }}
                    />
                    <Button label="Different" variant="secondary" compact onPress={() => setDismissed((d) => [...d, dup.id])} style={{ flex: 1 }} />
                  </View>
                </Card>
              )}

              <AttachmentPicker items={files} onChange={setFiles} required={photoRequired ? 1 : 0} hint={photoRequired ? "Take at least one clear photo of the asset." : "A photo helps the next technician find it."} />

              <View style={{ gap: 8 }}>
                <Label>Condition</Label>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {ASSET_CONDITIONS.map((o) => (
                    <Chip key={o} label={CONDITION_LABEL[o]} dot={CONDITION_HEX[o]} active={condition === o} onPress={() => setCondition(o)} />
                  ))}
                </View>
              </View>

              {kind === "node" && nodeType === "valve" && (
                <View style={{ gap: 8 }}>
                  <Label>Valve state</Label>
                  <Segmented value={isOpen} onChange={setIsOpen} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "unknown", label: "Unknown" }]} />
                </View>
              )}

              {kind === "node" && (
                <View style={{ gap: 8 }}>
                  <Label>Housed in</Label>
                  {STRUCTURE_ATTACHMENT_RULES[nodeType].length === 0 ? (
                    <Text v="small" tone="muted">
                      A {NODE_TYPE_LABEL[nodeType].toLowerCase()} isn&apos;t housed in a structure.
                    </Text>
                  ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Chip label="None" active={structureId === null} onPress={() => setStructureId(null)} />
                      {allowedStructures.slice(0, 12).map((s) => (
                        <Chip key={s.id} label={s.name} active={structureId === s.id} onPress={() => setStructureId(s.id)} />
                      ))}
                    </View>
                  )}
                </View>
              )}
            </>
          )}

          {kind === "pipe" && (
            <>
              <NodePicker label="From node" nodes={nodes} value={fromId} onChange={setFromId} />
              <NodePicker label="To node" nodes={nodes} value={toId} onChange={setToId} error={sameEnds ? "A pipe needs two different end nodes." : undefined} />
              <View style={{ gap: 8 }}>
                <Label>Material</Label>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {PIPE_MATERIALS.map((m) => (
                    <Chip key={m} label={materialLabel(m)} active={material === m} onPress={() => setMaterial(m)} />
                  ))}
                </View>
              </View>
              <SizeField label="Diameter (mm)" value={diameter} onChange={setDiameter} />
              <View style={{ gap: 8 }}>
                <Label>Condition</Label>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {ASSET_CONDITIONS.map((o) => (
                    <Chip key={o} label={CONDITION_LABEL[o]} dot={CONDITION_HEX[o]} active={condition === o} onPress={() => setCondition(o)} />
                  ))}
                </View>
              </View>
              <Card style={{ padding: 14 }}>
                <Text tone="muted">{pipeLength !== null && !sameEnds ? `Length about ${pipeLength} m, calculated from its path by the server.` : "Length is calculated from the pipe's path once both ends are chosen."}</Text>
              </Card>
            </>
          )}
        </ScrollView>
        <Footer>
          <Button label={job ? "Save to the job" : "Save to my changes"} disabled={!!issue} onPress={save} />
          <Hint issue={issue}>An engineer reviews it before it appears for everyone.</Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
