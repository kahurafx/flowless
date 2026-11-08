import { useLocalSearchParams, useRouter } from "expo-router";
import { CircleDot, ClipboardCheck, CloudUpload, Navigation, SearchX } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { TypeTile } from "../../../components/asset-row";
import { Button, Card, ConditionBadge, Divider, EmptyState, Header, Screen, SectionHeader, StatusPill, Text } from "../../../components/ui";
import { api } from "../../../lib/api";
import { openDirections } from "../../../lib/directions";
import { CONDITION_HEX, CONDITION_LABEL, describeJunction, formatCoords, formatDate, inspectionState, NODE_TYPE_LABEL, sortKey, timeAgo, titleCase } from "../../../lib/format";
import { usePullToRefresh } from "../../../lib/refresh";
import { useTheme } from "../../../lib/theme";
import { personName } from "../../../lib/work-orders";
import { useNetwork, useSession, useSync } from "../../../state/app";

type Photo = { id: string; url: string; fileName: string };

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text tone="muted">{label}</Text>
      <Text bold numberOfLines={1} style={{ flex: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

export default function AssetDetail() {
  const refreshControl = usePullToRefresh();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { user, abilities } = useSession();
  const { nodes, pipes, structures, connections, conditionLogs, valveLogs } = useNetwork();
  const { queue, online } = useSync();
  const node = nodes.find((n) => n.id === id);
  const [photos, setPhotos] = useState<Photo[]>([]);

  // Photos already on the server (K-08). Offline, or for an asset not sent yet, there are none to show.
  const settled = !!node && !node.pending;
  useEffect(() => {
    if (!id || !settled || !online) return;
    let alive = true;
    api.files.list
      .query({ subjectKind: "gis_asset", subjectId: id })
      .then((rows) => alive && setPhotos(rows.filter((r) => r.kind === "photo").map((r) => ({ id: r.id, url: r.url, fileName: r.fileName }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, settled, online]);

  if (!node) {
    // Pipes, structures and connections have no inspection screens yet: a summary is what a job's asset list opens.
    const pipe = pipes.find((p) => p.id === id);
    const structure = structures.find((s) => s.id === id);
    const connection = connections.find((x) => x.id === id);
    const title = pipe ? "Pipe" : structure ? structure.name : connection ? `Connection ${connection.connectionNumber}` : "Asset";
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title={title} subtitle={pipe ? "Pipe" : structure ? titleCase(structure.type) : connection ? "Service connection" : undefined} />
        {pipe ? (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
            <Card style={{ gap: 4, padding: 16 }}>
              <ConditionBadge condition={pipe.condition} />
              <Text style={{ marginTop: 8 }}>
                {titleCase(pipe.material)} · {pipe.diameterMm} mm · {Math.round(pipe.lengthM)} m
              </Text>
            </Card>
          </ScrollView>
        ) : structure ? (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
            <Card style={{ gap: 8, padding: 16 }}>
              <ConditionBadge condition={structure.condition} />
              <Text v="small" tone="muted">
                {formatCoords(structure.location)}
              </Text>
              <Button label="Directions" variant="secondary" icon={Navigation} compact onPress={() => openDirections(structure.location, structure.name)} />
            </Card>
          </ScrollView>
        ) : connection ? (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
            <Card style={{ gap: 8, padding: 16 }}>
              <Text v="small" tone="muted">
                {formatCoords(connection.location)}
              </Text>
              <Button label="Directions" variant="secondary" icon={Navigation} compact onPress={() => openDirections(connection.location, `Connection ${connection.connectionNumber}`)} />
            </Card>
          </ScrollView>
        ) : (
          <EmptyState icon={SearchX} title="Asset not found" body="It may have been deleted or isn't part of the network you can see." />
        )}
      </Screen>
    );
  }

  const housedIn = structures.find((s) => s.id === node.structureId);
  const waiting = queue.filter((q) => q.assetId === node.id && (q.status === "queued" || q.status === "failed")).length;
  const insp = inspectionState(node.lastInspectedAt);
  const isValve = node.type === "valve";
  // One timeline of inspections and valve operations, newest first.
  const history = [
    ...conditionLogs.filter((i) => i.assetId === node.id).map((i) => ({ id: i.id, at: i.recordedAt, by: i.recordedByUserId, note: i.note, kind: "condition" as const, condition: i.condition, isOpen: null as boolean | null })),
    ...valveLogs.filter((v) => v.nodeId === node.id).map((v) => ({ id: v.id, at: v.changedAt, by: v.changedByUserId, note: v.note, kind: "valve" as const, condition: null, isOpen: v.isOpen as boolean | null })),
  ].sort((a, b) => sortKey(b.at) - sortKey(a.at));
  const localPhotos = (node.attachments ?? []).filter((a) => a.kind === "photo");

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={node.name} subtitle={NODE_TYPE_LABEL[node.type]} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        <Card style={{ gap: 16, padding: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <TypeTile type={node.type} size={56} />
            <View style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: "row" }}>
                <ConditionBadge condition={node.condition} />
              </View>
              <Text v="small" tone="muted">
                {insp === "never" ? "Never inspected" : `Inspected ${timeAgo(node.lastInspectedAt)}`}
              </Text>
            </View>
            {insp !== "ok" && <StatusPill tone="warn" label={insp === "never" ? "Inspect" : "Overdue"} />}
          </View>
          {isValve && (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 14, backgroundColor: c.muted, paddingHorizontal: 16, paddingVertical: 12 }}>
              <Text tone="muted">Valve is</Text>
              <Text v="title">{node.isOpen === true ? "Open" : node.isOpen === false ? "Closed" : "Unknown"}</Text>
            </View>
          )}
          {waiting > 0 && <StatusPill tone="info" icon={CloudUpload} label={`${waiting} change${waiting === 1 ? "" : "s"} waiting to upload`} />}
          {node.pending && <StatusPill tone="info" label="Not on the server yet" />}
        </Card>

        <View style={{ marginTop: 16, gap: 12 }}>
          {abilities.edit && (
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button label="Record inspection" icon={ClipboardCheck} onPress={() => router.push({ pathname: "/inspect/[id]", params: { id: node.id } })} style={{ flex: 1 }} />
              {isValve && <Button label="Operate" variant="secondary" icon={CircleDot} onPress={() => router.push({ pathname: "/valve/[id]", params: { id: node.id } })} />}
            </View>
          )}
          <Button label="Directions" variant="secondary" icon={Navigation} onPress={() => openDirections(node.location, node.name)} />
        </View>

        <SectionHeader title="Details" />
        <Card style={{ overflow: "hidden" }}>
          <Detail label="Installed" value={formatDate(node.installedAt)} />
          <Divider />
          <Detail label="Housed in" value={housedIn ? `${housedIn.name} (${titleCase(housedIn.type)})` : "Not in a structure"} />
          <Divider />
          {node.junction && (
            <>
              <Detail label="Junction" value={describeJunction(node.junction)} />
              <Divider />
            </>
          )}
          <Detail label="Location" value={formatCoords(node.location)} />
          <Divider />
          <Detail label="Asset ID" value={node.id} />
        </Card>

        {(photos.length > 0 || localPhotos.length > 0) && (
          <>
            <SectionHeader title="Photos" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
              {localPhotos.map((a) => (
                <Image key={a.id} source={{ uri: a.uri }} style={{ width: 120, height: 120, borderRadius: 16 }} accessibilityLabel={a.fileName} />
              ))}
              {photos.map((p) => (
                <Image key={p.id} source={{ uri: p.url }} style={{ width: 120, height: 120, borderRadius: 16 }} accessibilityLabel={p.fileName} />
              ))}
            </ScrollView>
          </>
        )}

        <SectionHeader title="History" />
        <Card style={{ overflow: "hidden" }}>
          {history.length === 0 ? (
            <Text tone="muted" style={{ padding: 16 }}>
              No inspections recorded yet.
            </Text>
          ) : (
            history.map((h, i) => (
              <View key={h.id}>
                {i > 0 && <Divider />}
                <View style={{ gap: 4, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: h.condition ? CONDITION_HEX[h.condition] : c.mutedForeground }} />
                      <Text bold>{h.kind === "condition" ? `Inspected · ${CONDITION_LABEL[h.condition!]}` : `Valve ${h.isOpen ? "opened" : "closed"}`}</Text>
                    </View>
                    <Text v="small" tone="faint">
                      {timeAgo(h.at)}
                    </Text>
                  </View>
                  {h.note ? (
                    <Text v="small" tone="muted">
                      {h.note}
                    </Text>
                  ) : null}
                  <Text v="small" tone="faint">
                    {personName(h.by, user.id)}
                  </Text>
                </View>
              </View>
            ))
          )}
        </Card>
        {abilities.remove && (
          <Text v="small" tone="faint" style={{ marginTop: 24, textAlign: "center" }}>
            Assets are deleted from the web, where you can see what&apos;s affected and restore them later.
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}
