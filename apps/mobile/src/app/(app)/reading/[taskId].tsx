import type { ReadingOutcome, ReadingQuality } from "@flowless/shared-types";
import { READING_QUALITIES, readingFlagLabel } from "@flowless/shared-types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, Gauge, Repeat, SearchX, TriangleAlert } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { AttachmentPicker } from "../../../components/attachment-picker";
import { LocationCard } from "../../../components/location-card";
import { Button, Card, Chip, EmptyState, Field, Footer, Header, Hint, Notice, Screen, Segmented, Text } from "../../../components/ui";
import { timeAgo } from "../../../lib/format";
import { checkVisit, MISS_OUTCOMES, OUTCOME_LABEL, SUGGESTED_TAGS } from "../../../lib/readings";
import { radius, useTheme } from "../../../lib/theme";
import type { LatLng, LocalFile } from "../../../lib/types";
import { useReadings, useSession } from "../../../state/app";

/** One visit to a service point (M-04, M-06, M-07): read the dial, or say why it could not be read. */
export default function ReadingVisit() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { abilities } = useSession();
  const { tasks, recordVisit } = useReadings();
  const task = tasks.find((t) => t.id === taskId);

  const [mode, setMode] = useState<"read" | "miss">("read");
  const [dial, setDial] = useState("");
  const [rollover, setRollover] = useState(false);
  const [quality, setQuality] = useState<ReadingQuality>("good");
  const [place, setPlace] = useState<LatLng | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [outcome, setOutcome] = useState<ReadingOutcome | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const asOf = useMemo(() => new Date(), [dial, rollover]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = task && dial.trim() !== "" ? checkVisit(task, dial, asOf, rollover) : null;

  if (!abilities.readings || !task) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Meter reading" />
        <EmptyState icon={SearchX} title="Not found" body="This service point is no longer on your round." />
      </Screen>
    );
  }

  const title = task.accountNumber ?? `Service point ${task.servicePointId.slice(0, 8)}`;
  const dialDigits = task.meter?.dialDigits ?? 0;

  function finish(go: () => void) {
    go();
    router.back();
  }

  function saveRead() {
    if (!check || !check.ok || !task) return;
    const position = place ? { latitude: place.lat, longitude: place.lng } : undefined;
    const go = () => finish(() => recordVisit({ task, outcome: "read_ok", files, reading: { value: check.value, quality, rolloverConfirmed: rollover, ...(position ? { position } : {}) } }));
    if (check.blocking.length > 0 && !check.needsRolloverConfirmation) {
      Alert.alert("Save anyway?", `${check.blocking.map(readingFlagLabel).join("; ")}.\n\nThe reading is kept but held for a supervisor to review before it is billed. Check the dial first if you can.`, [
        { text: "Check again", style: "cancel" },
        { text: "Save for review", onPress: go },
      ]);
    } else go();
  }

  function saveMiss() {
    if (!outcome || !task) return;
    finish(() => recordVisit({ task, outcome, tags, note }));
  }

  const toggleTag = (t: string) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const readBlocked = !check || !check.ok || (check.needsRolloverConfirmation && !rollover);

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={title} subtitle={`Cycle ${task.cycleDate}${task.walkingSequence != null ? ` · stop ${task.walkingSequence}` : ""}`} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 18 }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: 4, padding: 14 }}>
            <Text bold>{task.meter ? `Meter ${task.meter.serial}` : "No meter on the phone"}</Text>
            <Text v="small" tone="muted">
              {task.previous ? `Last reading ${task.previous.value} (${timeAgo(task.previous.readAt)})` : "No earlier reading: this will be the first."}
            </Text>
            {check?.ok && check.hint && (
              <Text v="small" tone="muted">
                {check.hint.max !== null ? `Expect about ${check.hint.min} to ${check.hint.max} by now.` : "Not enough history for an expected range."}
              </Text>
            )}
            {task.state !== "to_read" && (
              <Text v="small" tone="warning">
                {task.state === "read" ? "Already read this cycle" : `Missed this cycle: ${task.lastOutcome ? OUTCOME_LABEL[task.lastOutcome] : "not read"}`}
                {task.pending ? " (not yet sent)" : ""}
              </Text>
            )}
          </Card>

          <Segmented options={[{ value: "read", label: "Read the meter" }, { value: "miss", label: "Couldn't read" }]} value={mode} onChange={setMode} />

          {mode === "read" ? (
            <>
              <Field
                label={`Dial reading${dialDigits ? ` (${dialDigits} digits)` : ""}`}
                value={dial}
                onChangeText={(t) => {
                  setDial(t);
                  setRollover(false);
                }}
                keyboardType="number-pad"
                maxLength={dialDigits || 12}
                placeholder="Digits as shown"
                style={{ opacity: task.meter ? 1 : 0.5 }}
                error={check && !check.ok ? check.error : undefined}
                hint={check?.ok && check.result.units !== null ? `${check.result.units} units since the last reading${check.result.rollover ? " (dial went round)" : ""}` : undefined}
              />

              {check?.ok && check.needsRolloverConfirmation && (
                <Notice tone="warn" icon={Repeat}>
                  <Text v="small" bold>
                    This is lower than the last reading ({task.previous?.value}).
                  </Text>
                  <Text v="small">Did the dial go all the way round past its highest number? Only say yes if it did.</Text>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                    <Button label={rollover ? "Yes, it went round" : "Yes, it went round"} compact variant={rollover ? "primary" : "secondary"} icon={rollover ? Check : undefined} onPress={() => setRollover(true)} style={{ flex: 1 }} />
                    <Button label="No, re-check" compact variant="ghost" onPress={() => setRollover(false)} style={{ flex: 1 }} />
                  </View>
                </Notice>
              )}
              {check?.ok && check.blocking.filter((f) => f !== "ROLLOVER_CANDIDATE").length > 0 && (
                <Notice tone="danger" icon={TriangleAlert}>
                  <Text v="small" bold>
                    Held for review if saved
                  </Text>
                  {check.blocking
                    .filter((f) => f !== "ROLLOVER_CANDIDATE")
                    .map((f) => (
                      <Text key={f} v="small">
                        {readingFlagLabel(f)}
                      </Text>
                    ))}
                </Notice>
              )}
              {check?.ok && check.advisory.length > 0 && (
                <Notice tone="info">
                  {check.advisory.map((f) => (
                    <Text key={f} v="small">
                      {readingFlagLabel(f)}
                    </Text>
                  ))}
                </Notice>
              )}

              <View style={{ gap: 8 }}>
                <Text v="small" bold>
                  How sure are you of the reading?
                </Text>
                <Segmented options={READING_QUALITIES.map((q) => ({ value: q, label: q.charAt(0).toUpperCase() + q.slice(1) }))} value={quality} onChange={setQuality} />
              </View>
              <LocationCard value={place} onChange={setPlace} empty="Record where you read it (optional)" />
              <AttachmentPicker items={files} onChange={setFiles} hint="Photograph the dial. The first photo is the reading's evidence." />
              {abilities.changeMeter && task.meterId && (
                <Button label="Replace this meter instead" variant="ghost" icon={Gauge} onPress={() => router.push({ pathname: "/meter-change/[taskId]", params: { taskId: task.id } })} />
              )}
            </>
          ) : (
            <>
              <View style={{ gap: 8 }}>
                <Text bold>Why couldn&apos;t you read it?</Text>
                {MISS_OUTCOMES.map((o) => {
                  const active = outcome === o;
                  return (
                    <Pressable
                      key={o}
                      onPress={() => setOutcome(o)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={{ minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: radius.xl, borderWidth: 2, paddingHorizontal: 14, borderColor: active ? c.primary : c.border, backgroundColor: active ? c.accent : c.card }}
                    >
                      <Text bold>{OUTCOME_LABEL[o]}</Text>
                      {active && <Check size={18} color={c.primary} />}
                    </Pressable>
                  );
                })}
              </View>
              <View style={{ gap: 8 }}>
                <Text v="small" bold>
                  Conditions
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {SUGGESTED_TAGS.map((t) => (
                    <Chip key={t} label={t} active={tags.includes(t)} onPress={() => toggleTag(t)} />
                  ))}
                </View>
              </View>
              <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={1000} hint={`${note.length}/1000`} />
              <Notice tone="info">Photos can only be attached to a reading, so a visit with no reading is saved without one. Put what you saw in the note.</Notice>
            </>
          )}
        </ScrollView>
        <Footer>
          {mode === "read" ? (
            <>
              <Button label="Save reading" disabled={readBlocked || !task.meter} onPress={saveRead} />
              <Hint issue={check?.ok && check.needsRolloverConfirmation && !rollover ? "Say whether the dial went round" : null}>Saved with the time on your phone. Uploads when you&apos;re online.</Hint>
            </>
          ) : (
            <>
              <Button label="Save visit" disabled={!outcome} onPress={saveMiss} />
              <Hint>After repeated misses the office is alerted to revisit.</Hint>
            </>
          )}
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
