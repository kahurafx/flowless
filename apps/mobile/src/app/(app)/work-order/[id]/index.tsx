import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, ChevronRight, MapPin, MapPinOff, Navigation, SearchX, TriangleAlert } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Card, Divider, EmptyState, Footer, Header, Screen, SectionHeader, StatusPill, Text } from "../../../../components/ui";
import { KindIcon } from "../../../../components/work-order-row";
import { approxMetres, formatCoords, formatDistance, timeAgo, titleCase } from "../../../../lib/format";
import { openDirections } from "../../../../lib/directions";
import { useLocation } from "../../../../lib/location";
import { usePullToRefresh } from "../../../../lib/refresh";
import { radius, useTheme } from "../../../../lib/theme";
import type { JobAsset } from "../../../../lib/types";
import { assetAction, dueLabel, isActive, jobProgress, kindInfo, OUTCOME_LABEL, personName, STATUS_PILL, toLatLng, usesJobBranch } from "../../../../lib/work-orders";
import { useJobs, useNetwork, useSession } from "../../../../state/app";

function AssetLine({ a, kind, orderId, canAct }: { a: JobAsset; kind: string; orderId: string; canAct: boolean }) {
  const router = useRouter();
  const { c } = useTheme();
  const action = assetAction(kind, a.type);
  const registered = a.state === "registered";
  return (
    <Pressable
      onPress={() => registered && router.push({ pathname: "/asset/[id]", params: { id: a.assetId } })}
      accessibilityRole="button"
      style={({ pressed }) => [{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }, pressed && { backgroundColor: c.accent }]}
    >
      <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: a.status === "done" ? c.success : "transparent", borderWidth: a.status === "done" ? 0 : 2, borderColor: c.input }}>
        {a.status === "done" && <Check size={16} color="#fff" />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text bold numberOfLines={1}>
          {a.name ?? "Unknown asset"}
        </Text>
        <Text v="small" tone="muted">
          {a.type ? titleCase(a.type) : "Asset"}
          {a.state === "proposed" ? " · New, not on the map yet" : a.state === "unavailable" ? " · No longer available" : ""}
        </Text>
        {a.possibleDuplicateOf ? (
          <Text v="small" tone="warning">
            Close to {a.possibleDuplicateOf}. Could be the same asset.
          </Text>
        ) : null}
      </View>
      {canAct && a.status === "pending" && action && a.state !== "unavailable" ? (
        <Button
          label={action === "valve" ? "Log valve" : "Inspect"}
          variant="secondary"
          compact
          onPress={() => router.push({ pathname: action === "valve" ? "/valve/[id]" : "/inspect/[id]", params: { id: a.assetId, workOrderId: orderId } })}
        />
      ) : registered ? (
        <ChevronRight size={18} color={c.input} />
      ) : null}
    </Pressable>
  );
}

export default function WorkOrderDetail() {
  const refreshControl = usePullToRefresh();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { user, abilities } = useSession();
  const { nodes } = useNetwork();
  const { workOrders, kinds, resumeOrder } = useJobs();
  const { point } = useLocation();
  const order = workOrders.find((o) => o.id === id);

  if (!order) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Work order" />
        <EmptyState icon={SearchX} title="Work order not found" body="It may have been reassigned." />
      </Screen>
    );
  }

  const info = kindInfo(kinds, order.kind);
  const asset = nodes.find((n) => n.id === order.assetId);
  const place = order.location ? toLatLng(order.location) : (asset?.location ?? null);
  const distance = point && place ? approxMetres(point, place) : null;
  const mine = order.assignedToUserId === user.id;
  const active = isActive(order);
  const canAct = abilities.act && active && (mine || abilities.manage);
  const parts = workOrders.filter((o) => o.parentId === order.id);
  const parent = workOrders.find((o) => o.id === order.parentId);
  const hasParts = parts.length > 0;
  const canReview = abilities.review && order.status === "submitted" && order.submission?.byUserId !== user.id;
  const { done, total } = jobProgress(order);
  const due = dueLabel(order.dueAt);
  const pill = STATUS_PILL[order.status];
  const sentBack = order.reviewed?.decision === "returned" && (order.status === "in_progress" || order.status === "pending");
  const onNetwork = usesJobBranch(info);
  const showAssets = order.assets.length > 0 || (canAct && onNetwork);

  const box = (tone: "warn" | "info" | "ok") => ({ marginTop: 12, gap: 4, borderRadius: radius["2xl"], padding: 16, backgroundColor: { warn: c.warningSoft, info: c.infoSoft, ok: c.successSoft }[tone] });
  const boxText = (tone: "warn" | "info" | "ok") => ({ color: { warn: c.warning, info: c.foreground, ok: c.success }[tone] });


  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={order.code} subtitle={info?.label} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        <Card style={{ gap: 12, padding: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
            <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: c.accent }}>
              <KindIcon kind={order.kind} size={24} color={c.primary} />
            </View>
            <Text v="title" style={{ flex: 1 }}>
              {order.title}
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <StatusPill label={pill.label} tone={pill.tone} />
            {order.priority === "urgent" && active && <StatusPill label="Urgent" tone="danger" />}
            {order.priority === "high" && active && <StatusPill label="High priority" tone="warn" />}
            {active && <StatusPill label={due.text} tone={due.overdue ? "danger" : "neutral"} />}
            {order.review === "required" && active && <StatusPill label="Needs approval" tone="neutral" />}
            {order.code === "New" && <StatusPill label="Not uploaded yet" tone="info" />}
          </View>
        </Card>

        {sentBack && order.reviewed && (
          <View style={box("warn")}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TriangleAlert size={18} color={c.warning} />
              <Text bold style={boxText("warn")}>
                Sent back by {personName(order.reviewed.byUserId, user.id)}
              </Text>
            </View>
            <Text v="small" style={boxText("warn")}>
              {order.reviewed.note}
            </Text>
          </View>
        )}

        {order.status === "submitted" && order.submission && (
          <View style={box("info")}>
            <Text bold>Waiting for approval · {timeAgo(order.submission.at)}</Text>
            <Text v="small" tone="muted">
              {OUTCOME_LABEL[order.submission.outcome]}. {order.submission.note}
            </Text>
          </View>
        )}

        {order.status === "blocked" && order.hold && (
          <View style={box("warn")}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TriangleAlert size={18} color={c.warning} />
              <Text bold style={boxText("warn")}>
                Not finished · {order.hold.reason}
              </Text>
            </View>
            {order.hold.note ? (
              <Text v="small" style={boxText("warn")}>
                {order.hold.note}
              </Text>
            ) : null}
          </View>
        )}

        {order.status === "completed" && order.completion && (
          <View style={box("ok")}>
            <Text bold style={boxText("ok")}>
              {order.completion.outcome ? OUTCOME_LABEL[order.completion.outcome] : "Completed"} · {timeAgo(order.completion.at)}
            </Text>
            {order.completion.note ? (
              <Text v="small" style={boxText("ok")}>
                {order.completion.note}
              </Text>
            ) : null}
            {order.reviewed?.decision === "approved" && (
              <Text v="small" style={boxText("ok")}>
                Approved by {personName(order.reviewed.byUserId, user.id)}
              </Text>
            )}
            {order.completion.photoCount > 0 && (
              <Text v="small" style={boxText("ok")}>
                {order.completion.photoCount} photo{order.completion.photoCount === 1 ? "" : "s"} attached
              </Text>
            )}
          </View>
        )}

        <SectionHeader title="Where" />
        <Card style={{ gap: 12, padding: 16 }}>
          {place ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <MapPin size={20} color={c.primary} />
                <View style={{ flex: 1 }}>
                  <Text bold>{distance !== null ? `${formatDistance(distance)} away` : "Location known"}</Text>
                  <Text v="small" tone="muted">
                    {order.locationNote ?? asset?.name ?? formatCoords(place)}
                  </Text>
                </View>
              </View>
              <Button label="Directions" icon={Navigation} variant="secondary" compact onPress={() => openDirections(place, order.title)} />
            </>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <MapPinOff size={20} color={c.input} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text bold>{order.locationNote ?? "No location given"}</Text>
                <Text v="small" tone="muted">
                  This job came in without a GPS position. Use the description to find it.
                </Text>
              </View>
            </View>
          )}
        </Card>

        {showAssets && (
          <>
            <SectionHeader title={total > 0 ? `Assets · ${done} of ${total} done` : "Assets"} />
            <Card style={{ overflow: "hidden" }}>
              {order.assets.length === 0 && (
                <Text tone="muted" style={{ padding: 16 }}>
                  No assets on this job yet. Add the ones you work on.
                </Text>
              )}
              {order.assets.map((a, i) => (
                <View key={a.assetId}>
                  {i > 0 && <Divider />}
                  <AssetLine a={a} kind={order.kind} orderId={order.id} canAct={canAct} />
                </View>
              ))}
              {canAct && onNetwork && (
                <>
                  <Divider />
                  {order.kind === "connection_capture" ? (
                    <View style={{ padding: 8 }}>
                      <Button label="Capture connection" variant="ghost" onPress={() => router.push({ pathname: "/capture-connection", params: { workOrderId: order.id } })} />
                    </View>
                  ) : (
                    <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
                      <Button label="Find asset" variant="ghost" onPress={() => router.push({ pathname: "/select-asset", params: { purpose: "job", workOrderId: order.id } })} style={{ flex: 1 }} />
                      <Button label="New asset" variant="ghost" onPress={() => router.push({ pathname: "/add-asset", params: { kind: "node", workOrderId: order.id } })} style={{ flex: 1 }} />
                    </View>
                  )}
                </>
              )}
            </Card>
          </>
        )}

        {(hasParts || parent) && (
          <>
            <SectionHeader title={hasParts ? `Parts of this job · ${parts.length}` : "Part of"} />
            <Card style={{ overflow: "hidden" }}>
              {(hasParts ? parts : parent ? [parent] : []).map((p, i) => (
                <View key={p.id}>
                  {i > 0 && <Divider />}
                  <Pressable
                    onPress={() => router.push({ pathname: "/work-order/[id]", params: { id: p.id } })}
                    accessibilityRole="button"
                    style={({ pressed }) => [{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 }, pressed && { backgroundColor: c.accent }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text bold numberOfLines={1}>
                        {p.title}
                      </Text>
                      <Text v="small" tone="muted">
                        {p.code}
                      </Text>
                    </View>
                    <StatusPill label={STATUS_PILL[p.status].label} tone={STATUS_PILL[p.status].tone} />
                  </Pressable>
                </View>
              ))}
            </Card>
            {hasParts && !abilities.review && (
              <Text v="small" tone="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
                This job is made up of parts. Finish the parts and a supervisor closes it.
              </Text>
            )}
          </>
        )}

        <SectionHeader title="Details" />
        <Card style={{ gap: 8, padding: 16 }}>
          {order.description ? <Text>{order.description}</Text> : <Text tone="faint">No description.</Text>}
          <Text v="small" tone="faint">
            {order.source} · raised {timeAgo(order.createdAt)}
          </Text>
        </Card>
      </ScrollView>

      {canAct && !hasParts && order.status === "blocked" && (
        <Footer>
          <Button label="Resume job" onPress={() => resumeOrder(order.id)} />
        </Footer>
      )}
      {canAct && !hasParts && order.status !== "blocked" && (
        <Footer>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button label="Couldn't finish" variant="secondary" onPress={() => router.push({ pathname: "/work-order/[id]/finish", params: { id: order.id, mode: "incomplete" } })} style={{ flex: 1 }} />
            <Button label={order.review === "required" ? "Submit" : "Mark complete"} onPress={() => router.push({ pathname: "/work-order/[id]/finish", params: { id: order.id, mode: "complete" } })} style={{ flex: 1 }} />
          </View>
        </Footer>
      )}
      {canAct && hasParts && abilities.review && (
        <Footer>
          <Button label="Finalize job" onPress={() => router.push({ pathname: "/work-order/[id]/finish", params: { id: order.id, mode: "finalize" } })} />
          <Text v="small" tone="faint" style={{ textAlign: "center", paddingBottom: 4 }}>
            {parts.filter((p) => p.status !== "completed" && p.status !== "cancelled").length} parts are still open. They won&apos;t block it.
          </Text>
        </Footer>
      )}
      {canReview && (
        <Footer>
          <Button label="Review work" onPress={() => router.push({ pathname: "/work-order/[id]/approve", params: { id: order.id } })} />
        </Footer>
      )}
    </Screen>
  );
}
