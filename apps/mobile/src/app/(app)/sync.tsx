import { useRouter } from "expo-router";
import { CircleCheck, Cloud, CloudOff, GitPullRequest, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { Alert, ScrollView, View } from "react-native";
import { Button, Card, Divider, EmptyState, Header, Screen, SectionHeader, StatusPill, Text } from "../../components/ui";
import { timeAgo } from "../../lib/format";
import { usePullToRefresh } from "../../lib/refresh";
import type { SyncItem, SyncStatus } from "../../lib/sync/ops";
import { useTheme } from "../../lib/theme";
import type { Tone } from "../../lib/work-orders";
import { useSession, useSync } from "../../state/app";

const OUTCOME: Record<SyncStatus, { label: string; tone: Tone; hint?: string }> = {
  queued: { label: "Waiting", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  applied: { label: "Saved", tone: "ok" },
  unchanged: { label: "No change needed", tone: "neutral" },
  stale: { label: "Kept as history", tone: "warn", hint: "The record is kept, but the asset wasn't changed: something newer already exists, or you can't change it there." },
  replayed: { label: "Already received", tone: "neutral" },
  rejected: { label: "Couldn't apply", tone: "danger", hint: "The server said no. Try again, discard it, or ask your supervisor." },
  dropped: { label: "Dropped", tone: "neutral", hint: "This was discarded and won't be sent." },
};

function ItemRow({ item }: { item: SyncItem }) {
  const { retryItem, discardItem, syncNow } = useSync();
  const o = OUTCOME[item.status];
  const confirmDiscard = () =>
    Alert.alert("Discard this?", "It won't reach the server, and any photos with it are removed from this phone.", [
      { text: "Keep it", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => discardItem(item.id) },
    ]);
  return (
    <View style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text bold>
            {item.title} · {item.assetName}
          </Text>
          <Text v="small" tone="muted">
            {item.detail} · {timeAgo(item.at)}
          </Text>
        </View>
        <StatusPill label={o.label} tone={o.tone} />
      </View>
      {item.error ? (
        <Text v="small" tone="danger">
          {item.error}
        </Text>
      ) : o.hint ? (
        <Text v="small" tone="muted">
          {o.hint}
        </Text>
      ) : null}
      {item.status === "failed" || item.status === "rejected" ? (
        <View style={{ marginTop: 4, flexDirection: "row", gap: 8 }}>
          <Button
            label="Try again"
            variant="secondary"
            icon={RefreshCw}
            compact
            onPress={() => {
              retryItem(item.id);
              void syncNow();
            }}
            style={{ flex: 1 }}
          />
          <Button label="Discard" variant="ghost" compact onPress={confirmDiscard} style={{ flex: 1 }} />
        </View>
      ) : null}
    </View>
  );
}

function Group({ title, icon: Icon, items, empty }: { title: string; icon: LucideIcon; items: SyncItem[]; empty: string }) {
  return (
    <>
      <SectionHeader title={title} />
      <Card style={{ overflow: "hidden" }}>
        {items.length === 0 ? (
          <EmptyState icon={Icon} title={empty} />
        ) : (
          items.map((i, idx) => (
            <View key={i.id}>
              {idx > 0 && <Divider />}
              <ItemRow item={i} />
            </View>
          ))
        )}
      </Card>
    </>
  );
}

export default function SyncScreen() {
  const refreshControl = usePullToRefresh();
  const router = useRouter();
  const { c } = useTheme();
  const { abilities } = useSession();
  const { queue, pending, awaitingReview, online, syncing, syncNow, lastSyncedAt } = useSync();

  const onDevice = queue.filter((i) => i.status === "queued" || i.status === "failed" || i.status === "rejected");
  const waitingReview = queue.filter((i) => i.status === "applied" && !i.reviewed);
  // A rejected item needs the person's attention, so it's listed with what's on the phone, not again under "done".
  const done = queue.filter((i) => !(i.status === "queued" || i.status === "failed" || i.status === "rejected") && !(i.status === "applied" && !i.reviewed));

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Sync" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        <Card style={{ gap: 12, padding: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: online ? c.successSoft : c.warningSoft }}>
              {online ? <Cloud size={22} color={c.success} /> : <CloudOff size={22} color={c.warning} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text v="lead" bold>
                {online ? "You're online" : "You're offline"}
              </Text>
              <Text v="small" tone="muted">
                {online ? `Last synced ${timeAgo(lastSyncedAt)}` : "Changes are saved on this phone until you reconnect."}
              </Text>
            </View>
          </View>
          <Button label={syncing ? "Syncing…" : pending > 0 ? `Upload ${pending} change${pending === 1 ? "" : "s"}` : "Sync now"} icon={RefreshCw} loading={syncing} disabled={!online} onPress={syncNow} />
        </Card>

        <Group title="On this phone" icon={CircleCheck} items={onDevice} empty="Nothing waiting to upload" />

        <SectionHeader title="Waiting for review" />
        <Card style={{ gap: 12, padding: 16 }}>
          {abilities.post && <Button label="See what's under review" variant="secondary" compact onPress={() => router.push("/review")} />}
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
            <GitPullRequest size={20} color={c.primary} style={{ marginTop: 2 }} />
            <Text style={{ flex: 1 }}>
              {awaitingReview > 0
                ? `${awaitingReview} of your changes reached the server. An engineer reviews edits to the network before they appear on the live map for everyone.`
                : "Everything you've sent has been reviewed."}
            </Text>
          </View>
          {waitingReview.length > 0 && (
            <View style={{ overflow: "hidden", borderRadius: 14, borderWidth: 1, borderColor: c.border }}>
              {waitingReview.map((i, idx) => (
                <View key={i.id}>
                  {idx > 0 && <Divider />}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
                    <Text v="small" numberOfLines={1} style={{ flex: 1 }}>
                      {i.title} · {i.assetName}
                    </Text>
                    <Text v="caption" tone="faint">
                      {timeAgo(i.at)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Card>

        <Group title="Recently sent" icon={CircleCheck} items={done} empty="Nothing sent yet" />

        <View style={{ marginTop: 24, flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 4 }}>
          <TriangleAlert size={16} color={c.input} style={{ marginTop: 2 }} />
          <Text v="small" tone="faint" style={{ flex: 1 }}>
            Unsent work is saved on this phone, even if the app closes. If something goes wrong sending, it stays here until it goes through or you discard it.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
