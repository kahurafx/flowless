import { useRouter } from "expo-router";
import { Gauge } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { Card, Chip, EmptyState, Header, Row, Screen, SearchField, StatusPill, Text } from "../../components/ui";
import { countByState, orderTasks, OUTCOME_LABEL, searchTasks, type RoundTask, type TaskState } from "../../lib/readings";
import { usePullToRefresh } from "../../lib/refresh";
import type { Tone } from "../../lib/work-orders";
import { useReadings, useSession } from "../../state/app";

const STATE: Record<TaskState, { label: string; tone: Tone }> = {
  to_read: { label: "To read", tone: "info" },
  read: { label: "Read", tone: "ok" },
  missed: { label: "Missed", tone: "warn" },
};

/** The route's reading tasks for the cycle (M-08), kept on the phone so the round works without signal. */
export default function ReadingRound() {
  const router = useRouter();
  const refreshControl = usePullToRefresh();
  const { abilities } = useSession();
  const { rounds, tasks } = useReadings();
  const [routeId, setRouteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskState | "all">("all");
  const [query, setQuery] = useState("");

  const round = rounds.find((r) => r.routeId === routeId) ?? rounds[0];
  const inRound = useMemo(() => tasks.filter((t) => t.snapshotId === round?.id), [tasks, round?.id]);
  const counts = countByState(inRound);
  const shown = useMemo(() => orderTasks(searchTasks(inRound.filter((t) => filter === "all" || t.state === filter), query)), [inRound, filter, query]);

  if (!abilities.readings) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Reading round" />
        <EmptyState icon={Gauge} title="Not available" body="Meter reading is not licensed, or your role cannot capture readings." />
      </Screen>
    );
  }

  const renderItem = ({ item: t }: { item: RoundTask }) => {
    const s = STATE[t.state];
    return (
      <Row onPress={() => router.push({ pathname: "/reading/[taskId]", params: { taskId: t.id } })} accessibilityLabel={`${t.accountNumber ?? "Service point"}, ${s.label}`}>
        <View style={{ width: 40, alignItems: "center" }}>
          <Text bold tone="muted">
            {t.walkingSequence ?? "-"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text bold numberOfLines={1}>
            {t.accountNumber ?? `Service point ${t.servicePointId.slice(0, 8)}`}
          </Text>
          <Text v="small" tone="muted" numberOfLines={1}>
            {t.meter ? `Meter ${t.meter.serial}` : "No meter on the phone"}
            {t.previous ? ` · last ${t.previous.value}` : ""}
            {t.lastOutcome && t.lastOutcome !== "read_ok" ? ` · ${OUTCOME_LABEL[t.lastOutcome]}` : ""}
          </Text>
        </View>
        <StatusPill label={t.pending ? `${s.label} (unsent)` : s.label} tone={s.tone} />
      </Row>
    );
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Reading round" subtitle={round ? `${round.routeName} · cycle ${round.cycleDate}` : undefined} />
      {rounds.length === 0 ? (
        <EmptyState icon={Gauge} title="No round on the phone" body="Reading tasks appear once the office has taken the route's eligibility snapshot. Sync while online to fetch them." />
      ) : (
        <>
          <View style={{ gap: 10, paddingHorizontal: 16, paddingBottom: 8 }}>
            {rounds.length > 1 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {rounds.map((r) => (
                  <Chip key={r.id} label={r.routeName} active={r.id === round?.id} onPress={() => setRouteId(r.routeId)} />
                ))}
              </View>
            )}
            <SearchField value={query} onChangeText={setQuery} placeholder="Account, meter serial or service point" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Chip label={`All ${inRound.length}`} active={filter === "all"} onPress={() => setFilter("all")} />
              <Chip label={`To read ${counts.to_read}`} active={filter === "to_read"} onPress={() => setFilter("to_read")} />
              <Chip label={`Missed ${counts.missed}`} active={filter === "missed"} onPress={() => setFilter("missed")} />
              <Chip label={`Read ${counts.read}`} active={filter === "read"} onPress={() => setFilter("read")} />
            </View>
          </View>
          <Card style={{ flex: 1, marginHorizontal: 16, marginBottom: 12, overflow: "hidden" }}>
            <FlatList
              data={shown}
              keyExtractor={(t) => t.id}
              renderItem={renderItem}
              refreshControl={refreshControl}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={<EmptyState icon={Gauge} title="Nothing here" body={query ? "No service point matches your search." : "No tasks in this list."} />}
            />
          </Card>
        </>
      )}
    </Screen>
  );
}
