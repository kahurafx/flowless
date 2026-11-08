import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, ChevronRight, SearchX, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { Button, Card, Divider, EmptyState, Field, Footer, Header, Notice, Screen, SectionHeader, StatusPill, Text } from "../../../../components/ui";
import { initialsOf, timeAgo, titleCase } from "../../../../lib/format";
import { radius, useTheme } from "../../../../lib/theme";
import { OUTCOME_LABEL, personName } from "../../../../lib/work-orders";
import { useJobs, useReview, useSession } from "../../../../state/app";

/**
 * A supervisor checks submitted work: what was done, the evidence, and which assets are new or look
 * like duplicates. Approving closes the job. It does NOT post the data: an engineer does that
 * separately (`gis:post`).
 */
export default function ApproveWork() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { user, abilities } = useSession();
  const { workOrders, reviewOrder } = useJobs();
  const { branches } = useReview();
  const order = workOrders.find((o) => o.id === id);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!order || order.status !== "submitted" || !order.submission) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Review work" />
        <EmptyState icon={SearchX} title="Nothing to review" body="This job was already approved or sent back." />
      </Screen>
    );
  }

  const sub = order.submission;
  const own = sub.byUserId === user.id;
  const allowed = abilities.review && !own;
  const photos = order.photoCount;
  const fresh = order.assets.filter((a) => a.state === "proposed");
  const branch = branches.find((b) => b.branch === order.branch);

  function decide(decision: "approve" | "return") {
    const res = reviewOrder(order!.id, decision, note);
    if (!res.ok) return setError(res.reason);
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Review work" subtitle={`${order.code} · ${order.title}`} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: 12, padding: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24, backgroundColor: c.primary }}>
                <Text bold tone="inverse">
                  {initialsOf(personName(sub.byUserId, user.id)) || "?"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text bold>{personName(sub.byUserId, user.id)}</Text>
                <Text v="small" tone="muted">
                  Submitted {timeAgo(sub.at)}
                </Text>
              </View>
              <StatusPill label={OUTCOME_LABEL[sub.outcome]} tone={sub.outcome === "done" ? "ok" : "warn"} />
            </View>
            {sub.note ? <Text>{sub.note}</Text> : <Text tone="faint">No note.</Text>}
            <Text v="small" tone={photos === 0 ? "warning" : "muted"}>
              {photos === 0 ? "No photos attached." : `${photos} photo${photos === 1 ? "" : "s"} attached.`}
            </Text>
          </Card>

          {order.assets.length > 0 && (
            <>
              <SectionHeader title={`Assets · ${order.assets.length}`} />
              <Card style={{ overflow: "hidden" }}>
                {order.assets.map((a, i) => (
                  <View key={a.assetId}>
                    {i > 0 && <Divider />}
                    <View style={{ minHeight: 64, gap: 2, paddingHorizontal: 16, paddingVertical: 12 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        {a.status === "done" ? <Check size={16} color={c.success} /> : <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: c.input }} />}
                        <Text bold numberOfLines={1} style={{ flex: 1 }}>
                          {a.name ?? "Unknown asset"}
                        </Text>
                        {a.state === "proposed" ? <StatusPill label="New" tone="info" /> : a.state === "unavailable" ? <StatusPill label="Unavailable" tone="danger" /> : <StatusPill label="On the map" tone="neutral" />}
                      </View>
                      <Text v="small" tone="muted">
                        {a.type ? titleCase(a.type) : "Asset"} · {a.status === "done" ? "Done" : "Not done"}
                      </Text>
                      {a.possibleDuplicateOf ? (
                        <View style={{ marginTop: 4, flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <TriangleAlert size={14} color={c.warning} />
                          <Text v="small" tone="warning" style={{ flex: 1 }}>
                            Close to {a.possibleDuplicateOf}. Check it isn&apos;t the same asset.
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                ))}
              </Card>
              {fresh.length > 0 && (
                <Text v="small" tone="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
                  {fresh.length} new asset{fresh.length === 1 ? "" : "s"} will only reach the live map once an engineer posts the changes.
                </Text>
              )}
            </>
          )}

          {order.branch && (
            <>
              <SectionHeader title="Data changes" />
              {abilities.post && branch ? (
                <Pressable
                  onPress={() => router.push({ pathname: "/review/[branch]", params: { branch: branch.branch } })}
                  accessibilityRole="button"
                  style={({ pressed }) => [{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius["2xl"], borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 16, paddingVertical: 12 }, pressed && { backgroundColor: c.accent }]}
                >
                  <Text style={{ flex: 1 }}>See what this job changed on the map</Text>
                  <ChevronRight size={18} color={c.input} />
                </Pressable>
              ) : (
                <Card style={{ padding: 16 }}>
                  <Text v="small" tone="muted">
                    This job also changed the network data. An engineer reviews and posts those changes after you approve the work.
                  </Text>
                </Card>
              )}
            </>
          )}

          {own && (
            <View style={{ marginTop: 16 }}>
              <Notice tone="warn">You submitted this yourself, so someone else has to approve it.</Notice>
            </View>
          )}

          {returning && (
            <View style={{ marginTop: 16 }}>
              <Field
                label="What needs fixing?"
                value={note}
                onChangeText={(t) => {
                  setNote(t);
                  setError(null);
                }}
                multiline
                maxLength={2000}
                placeholder="Be specific so they can fix it in one visit."
                error={error ?? undefined}
              />
            </View>
          )}
          {!returning && error && (
            <Text v="small" tone="danger" style={{ marginTop: 12 }}>
              {error}
            </Text>
          )}
        </ScrollView>

        <Footer>
          {returning ? (
            <>
              <Button label="Send back" disabled={!note.trim()} onPress={() => decide("return")} />
              <Button
                label="Cancel"
                variant="ghost"
                compact
                onPress={() => {
                  setReturning(false);
                  setNote("");
                  setError(null);
                }}
              />
            </>
          ) : (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button label="Send back" variant="secondary" disabled={!allowed} onPress={() => setReturning(true)} style={{ flex: 1 }} />
              <Button label="Approve" disabled={!allowed} onPress={() => decide("approve")} style={{ flex: 1 }} />
            </View>
          )}
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
