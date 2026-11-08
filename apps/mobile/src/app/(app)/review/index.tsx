import { useRouter } from "expo-router";
import { ChevronRight, CircleCheck } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { Card, EmptyState, Header, Screen, StatusPill, Text } from "../../../components/ui";
import { initialsOf } from "../../../lib/format";
import { usePullToRefresh } from "../../../lib/refresh";
import { formatRange, ORIGIN_LABEL, summarize } from "../../../lib/review";
import { useTheme } from "../../../lib/theme";
import { personName } from "../../../lib/work-orders";
import { useReview, useSession } from "../../../state/app";

export default function ReviewList() {
  const refreshControl = usePullToRefresh();
  const router = useRouter();
  const { c } = useTheme();
  const { user, abilities } = useSession();
  const { branches } = useReview();

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={abilities.post ? "Review changes" : "Changes under review"} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }} refreshControl={refreshControl} showsVerticalScrollIndicator={false}>
        <Text v="small" tone="muted" style={{ paddingHorizontal: 4 }}>
          {abilities.post
            ? "Field edits stay separate from the live network until you approve them. Each set is posted all together or not at all."
            : "These are field edits waiting for an engineer. They go live once approved."}
        </Text>

        {branches.length === 0 ? (
          <EmptyState icon={CircleCheck} title="Nothing to review" body="New sets of changes appear here once technicians upload them." />
        ) : (
          branches.map((b) => {
            const s = summarize(b);
            const author = b.authorIds.map((id) => personName(id, user.id)).join(", ") || "A teammate";
            return (
              <Pressable key={b.branch} onPress={() => router.push({ pathname: "/review/[branch]", params: { branch: b.branch } })} accessibilityRole="button">
                <Card style={{ gap: 12, padding: 16 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24, backgroundColor: c.primary }}>
                      <Text bold tone="inverse">
                        {initialsOf(author) || "?"}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text bold>{author}</Text>
                      <Text v="small" tone="muted">
                        {formatRange(b.firstEditAt, b.lastEditAt)}
                      </Text>
                    </View>
                    {b.origin && <StatusPill label={`${b.origin.ref} · ${ORIGIN_LABEL[b.origin.status] ?? b.origin.status}`} tone={b.origin.status === "completed" ? "ok" : "info"} />}
                    <ChevronRight size={18} color={c.input} />
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    <Text v="small" tone="muted">
                      {s.total} change{s.total === 1 ? "" : "s"}
                    </Text>
                    {s.conflicts > 0 ? <StatusPill label={`${s.conflicts} need${s.conflicts === 1 ? "s" : ""} a decision`} tone="warn" /> : <StatusPill label="Ready to post" tone="ok" />}
                  </View>
                </Card>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
