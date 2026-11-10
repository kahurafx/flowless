import { useRouter } from "expo-router";
import { Gauge, ChevronDown, ChevronRight, CircleCheck, ClipboardCheck, CloudOff, GitPullRequest, RefreshCw } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AssetRow, TypeTile } from "../../../components/asset-row";
import { Button, Card, ConditionBadge, Divider, Screen, SectionHeader, Text } from "../../../components/ui";
import { WorkOrderRow } from "../../../components/work-order-row";
import { CONDITION_LABEL, inspectionState, sortKey, timeAgo } from "../../../lib/format";
import { useLocation } from "../../../lib/location";
import { roleLabel } from "../../../lib/permissions";
import { usePullToRefresh } from "../../../lib/refresh";
import { radius, TAB_SPACE, TOUCH, useTheme } from "../../../lib/theme";
import type { AppNode } from "../../../lib/types";
import { rankOrders } from "../../../lib/work-orders";
import { useJobs, useNetwork, useReadings, useReview, useSession, useSync } from "../../../state/app";

/** Critical first, then poor, then whatever has gone longest without a visit. */
const rank = (n: AppNode) => (n.condition === "critical" ? 0 : n.condition === "poor" ? 1 : 2);

function reasonFor(n: AppNode): string | null {
  if (n.condition === "critical" || n.condition === "poor") return `${CONDITION_LABEL[n.condition]} condition · last inspected ${timeAgo(n.lastInspectedAt)}`;
  const state = inspectionState(n.lastInspectedAt);
  if (state === "never") return "Never inspected";
  if (state === "overdue") return `Inspection overdue · last done ${timeAgo(n.lastInspectedAt)}`;
  return null;
}

export default function HomeScreen() {
  const refreshControl = usePullToRefresh();
  const router = useRouter();
  const { c } = useTheme();
  const { user, org, role, abilities, hasGis } = useSession();
  const { nodes } = useNetwork();
  const { myOrders, approvals } = useJobs();
  const { branches } = useReview();
  const { tasks: readingTasks } = useReadings();
  const { pending, awaitingReview, online, syncing, syncNow, lastSyncedAt } = useSync();
  const { point, status: gpsStatus, request: requestGps } = useLocation();
  const [syncOpen, setSyncOpen] = useState(false);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const initials = user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  // Assigned work comes first. With none, suggest the asset that most needs a visit.
  const todo = myOrders.filter((o) => o.status !== "completed" && o.status !== "submitted");
  const orders = abilities.seeJobs ? rankOrders(todo, nodes, point) : [];
  const sorted = [...nodes].sort((a, b) => rank(a) - rank(b) || sortKey(a.lastInspectedAt) - sortKey(b.lastInspectedAt));
  const top = sorted[0];
  const nextUp = hasGis && orders.length === 0 && top && reasonFor(top) ? top : null;

  // Assets that already have a pending order are being handled, so don't repeat them.
  const covered = new Set(todo.map((o) => o.assetId).filter(Boolean));
  const attention = hasGis
    ? nodes
        .filter((n) => (n.condition === "poor" || n.condition === "critical") && n.id !== nextUp?.id && !covered.has(n.id))
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, 3)
    : [];

  const syncTitle = !online ? "Offline" : pending > 0 ? `${pending} change${pending === 1 ? "" : "s"} to upload` : "All synced";
  const syncSub = online ? `Last synced ${timeAgo(lastSyncedAt)}` : pending > 0 ? `${pending} saved on this phone` : "Changes are saved on this phone";
  const syncTone = !online ? { bg: c.warningSoft, fg: c.warning } : pending > 0 ? { bg: c.infoSoft, fg: c.info } : { bg: c.successSoft, fg: c.success };

  const banner = (onPress: () => void, icon: React.ReactNode, title: string, sub: string) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius["2xl"], borderWidth: 1, borderColor: c.primary + "55", backgroundColor: c.accent, paddingHorizontal: 16, paddingVertical: 12, marginTop: 12 }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text bold>{title}</Text>
        <Text v="small" tone="muted">
          {sub}
        </Text>
      </View>
      <ChevronRight size={18} color={c.mutedForeground} />
    </Pressable>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: TAB_SPACE + 16 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 4, paddingBottom: 20 }}>
          <View style={{ flex: 1 }}>
            <Text v="heading">
              {greeting}, {user.name.split(" ")[0]}
            </Text>
            <Text v="small" tone="muted" numberOfLines={1}>
              {org.name} · {roleLabel(role)}
            </Text>
          </View>
          <Pressable
            onPress={() => router.navigate("/profile")}
            accessibilityRole="button"
            accessibilityLabel="Open profile"
            style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: c.primary }}
          >
            <Text bold tone="inverse">
              {initials}
            </Text>
          </Pressable>
        </View>

        {/* Sync: one quiet row, expands in place */}
        <Card style={{ overflow: "hidden" }}>
          <Pressable
            onPress={() => setSyncOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityState={{ expanded: syncOpen }}
            accessibilityLabel={`${syncTitle}. ${syncSub}`}
            style={({ pressed }) => [{ minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }, pressed && { backgroundColor: c.accent }]}
          >
            <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: syncTone.bg }}>
              {!online ? <CloudOff size={18} color={syncTone.fg} /> : pending > 0 ? <RefreshCw size={18} color={syncTone.fg} /> : <CircleCheck size={18} color={syncTone.fg} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text bold>{syncTitle}</Text>
              <Text v="small" tone="muted">
                {syncSub}
              </Text>
            </View>
            <View style={{ transform: [{ rotate: syncOpen ? "180deg" : "0deg" }] }}>
              <ChevronDown size={20} color={c.input} />
            </View>
          </Pressable>

          {syncOpen && (
            <View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 16 }}>
              <Divider />
              <Text v="small" tone="muted">
                {!online
                  ? "You're offline. Everything you do is saved on this phone and uploads when you reconnect."
                  : pending > 0
                    ? "These changes are saved on this phone and haven't reached the server yet."
                    : "Nothing is waiting. Changes you make are saved on this phone first, then uploaded."}
                {awaitingReview > 0 && !abilities.post ? ` ${awaitingReview} sent change${awaitingReview === 1 ? " is" : "s are"} waiting for an engineer to review.` : ""}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label={syncing ? "Syncing…" : "Sync now"} icon={RefreshCw} loading={syncing} disabled={!online || pending === 0} onPress={syncNow} compact style={{ flex: 1 }} />
                <Button label="Details" variant="secondary" onPress={() => router.push("/sync")} compact style={{ flex: 1 }} />
              </View>
            </View>
          )}
        </Card>

        {abilities.review && approvals.length > 0 &&
          banner(
            () => router.push({ pathname: "/work-orders", params: { tab: "approval" } }),
            <ClipboardCheck size={22} color={c.primary} />,
            `${approvals.length} job${approvals.length === 1 ? "" : "s"} waiting for approval`,
            "Work sent in by your team",
          )}

        {abilities.readings && readingTasks.length > 0 &&
          banner(
            () => router.push("/reading-round"),
            <Gauge size={22} color={c.primary} />,
            "Reading round",
            `${readingTasks.filter((t) => t.state === "to_read").length} of ${readingTasks.length} to read`,
          )}

        {orders.length > 0 && (
          <>
            <SectionHeader title={`Work orders · ${orders.length}`} action="See all" onAction={() => router.push("/work-orders")} />
            <Card style={{ overflow: "hidden" }}>
              {orders.slice(0, 3).map((item, i) => (
                <View key={item.order.id}>
                  {i > 0 && <Divider />}
                  <WorkOrderRow item={item} me={user.id} onPress={() => router.push({ pathname: "/work-order/[id]", params: { id: item.order.id } })} />
                </View>
              ))}
            </Card>
            {gpsStatus !== "granted" && (
              <Pressable onPress={requestGps} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 4 }}>
                <Text v="small" tone="primary" bold>
                  Turn on location to see which jobs are closest
                </Text>
              </Pressable>
            )}
          </>
        )}

        {nextUp && (
          <>
            <SectionHeader title="Next up" />
            <Card style={{ gap: 16, padding: 16 }}>
              <Pressable onPress={() => router.push({ pathname: "/asset/[id]", params: { id: nextUp.id } })} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <TypeTile type={nextUp.type} size={52} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text v="lead" bold numberOfLines={1}>
                    {nextUp.name}
                  </Text>
                  <Text v="small" tone="muted">
                    {reasonFor(nextUp)}
                  </Text>
                </View>
                <ChevronRight size={18} color={c.input} />
              </Pressable>
              <View style={{ flexDirection: "row" }}>
                <ConditionBadge condition={nextUp.condition} />
              </View>
              {abilities.edit && <Button label="Record inspection" icon={ClipboardCheck} onPress={() => router.push({ pathname: "/inspect/[id]", params: { id: nextUp.id } })} />}
            </Card>
          </>
        )}

        {attention.length > 0 && (
          <>
            <SectionHeader title="Needs attention" action="See all" onAction={() => router.navigate({ pathname: "/assets", params: { filter: "attention" } })} />
            <Card style={{ overflow: "hidden" }}>
              {attention.map((n, i) => (
                <View key={n.id}>
                  {i > 0 && <Divider />}
                  <AssetRow node={n} onPress={() => router.push({ pathname: "/asset/[id]", params: { id: n.id } })} />
                </View>
              ))}
            </Card>
          </>
        )}

        {orders.length === 0 && !nextUp && attention.length === 0 && (
          <Card style={{ marginTop: 24, flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
            <CircleCheck size={22} color={c.success} />
            <Text style={{ flex: 1 }}>You&apos;re all caught up. Nothing needs attention right now.</Text>
          </Card>
        )}

        {abilities.post && branches.length > 0 &&
          banner(() => router.push("/review"), <GitPullRequest size={22} color={c.primary} />, "Review changes", `${branches.length} set${branches.length === 1 ? "" : "s"} waiting`)}
      </ScrollView>
    </Screen>
  );
}
