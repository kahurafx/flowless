import { useLocalSearchParams, useRouter } from "expo-router";
import { MapPin, SearchX, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Switch, View } from "react-native";
import { AttachmentPicker } from "../../../../components/attachment-picker";
import { Button, Chip, EmptyState, Field, Footer, Header, Hint, Notice, Screen, Segmented, Text } from "../../../../components/ui";
import { useLocation } from "../../../../lib/location";
import { photosStillNeeded } from "../../../../lib/sync/build";
import { radius, useTheme } from "../../../../lib/theme";
import type { LocalFile, WorkOrderOutcome } from "../../../../lib/types";
import { CAPTURE_FIELDS, captureProblem, finishOutcomes, HOLD_REASONS, kindInfo, OUTCOME_LABEL } from "../../../../lib/work-orders";
import { useJobs } from "../../../../state/app";

type Mode = "complete" | "incomplete" | "finalize";

/**
 * Every ending of a job. Finishing needs whatever the kind's evidence asks for (photos on the job, a
 * GPS position) and its completion data. If the kind needs approval, finishing means "submit": a
 * supervisor then approves it or sends it back. Not finishing needs a reason. Finalize is for a
 * supervisor closing a job made of parts.
 */
export default function FinishWorkOrder() {
  const { id, mode: initial } = useLocalSearchParams<{ id: string; mode?: Mode }>();
  const router = useRouter();
  const { c } = useTheme();
  const { workOrders, kinds, finishOrder, holdOrder, finalizeOrder } = useJobs();
  const { point, accuracyM, refresh } = useLocation();
  const order = workOrders.find((o) => o.id === id);

  const [mode, setMode] = useState<Mode>(initial === "incomplete" ? "incomplete" : initial === "finalize" ? "finalize" : "complete");
  const [outcome, setOutcome] = useState<WorkOrderOutcome | null>(null);
  const [askApproval, setAskApproval] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [capture, setCapture] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!order) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Work order" />
        <EmptyState icon={SearchX} title="Work order not found" />
      </Screen>
    );
  }

  const info = kindInfo(kinds, order.kind);
  const options = mode === "finalize" ? [{ outcome: "done" as const }, { outcome: "partial" as const }] : finishOutcomes(order, info);
  const chosen = outcome ?? options.find((o) => !("disabled" in o && o.disabled))?.outcome ?? "done";
  const submit = order.review === "required" || (order.review === "optional" && askApproval);
  const photoCount = files.filter((f) => f.kind === "photo").length;
  // Evidence is judged by the server on the photos it has, so the job's own count comes off what is asked for.
  const needPhotos = mode === "complete" ? photosStillNeeded(info?.evidence, order.photoCount, 0) : 0;
  const missingPhotos = mode === "complete" ? photosStillNeeded(info?.evidence, order.photoCount, photoCount) : 0;
  const needsGps = mode === "complete" && !!info?.evidence.gps;
  const fields = info?.hasCapture ? (CAPTURE_FIELDS[info.key] ?? []) : [];
  const noteNeeded = mode === "complete" ? chosen !== "done" : mode === "incomplete" ? reason === "Other" : false;

  const issue =
    mode === "complete"
      ? missingPhotos > 0
        ? `Add ${missingPhotos} more photo${missingPhotos === 1 ? "" : "s"} of the work`
        : captureProblem(info, capture) ?? (noteNeeded && !note.trim() ? "Say what you did or found" : null)
      : mode === "incomplete"
        ? !reason
          ? "Choose a reason"
          : noteNeeded && !note.trim()
            ? "Add a short note"
            : null
        : null;

  const label = mode === "complete" ? (submit ? "Submit for approval" : "Mark complete") : mode === "incomplete" ? "Report not finished" : "Finalize job";

  async function save() {
    if (issue || !order || saving) return;
    setSaving(true);
    setError(null);
    // Where the work was done: a fresh fix if the kind needs one, otherwise whatever the phone last had.
    const fix = needsGps ? await refresh() : null;
    const position = fix?.point ?? point;
    const res =
      mode === "complete"
        ? finishOrder(order.id, { outcome: chosen, note: note.trim(), files, submit, capture, position })
        : mode === "incomplete"
          ? holdOrder(order.id, { reason: reason!, note: note.trim(), files })
          : finalizeOrder(order.id, { outcome: chosen, note: note.trim() });
    setSaving(false);
    if (!res.ok) return setError(res.reason);
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title={mode === "finalize" ? "Finalize job" : "Finish job"} subtitle={order.title} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          {mode !== "finalize" && (
            <Segmented<"complete" | "incomplete">
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(null);
              }}
              options={[{ value: "complete", label: submit ? "Finished" : "Completed" }, { value: "incomplete", label: "Couldn't finish" }]}
            />
          )}

          {error && (
            <Notice tone="danger" icon={TriangleAlert}>
              {error}
            </Notice>
          )}

          {mode !== "incomplete" ? (
            <View style={{ gap: 8 }}>
              <Text bold>What was the result?</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {options.map((o) => (
                  <Chip key={o.outcome} label={OUTCOME_LABEL[o.outcome]} active={chosen === o.outcome} onPress={() => !("disabled" in o && o.disabled) && setOutcome(o.outcome)} />
                ))}
              </View>
              {options.map((o) =>
                "hint" in o && o.hint ? (
                  <Text key={o.outcome} v="small" tone="warning">
                    {OUTCOME_LABEL[o.outcome]}: {o.hint}
                  </Text>
                ) : null,
              )}
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              <Text bold>Why couldn&apos;t you finish?</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {HOLD_REASONS.map((r) => (
                  <Chip key={r} label={r} active={reason === r} onPress={() => setReason(r)} />
                ))}
              </View>
            </View>
          )}

          {mode === "complete" && order.review === "optional" && (
            <View style={{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius["2xl"], borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 16 }}>
              <View style={{ flex: 1 }}>
                <Text>Ask a supervisor to check it</Text>
                <Text v="small" tone="muted">
                  Optional for this kind of job
                </Text>
              </View>
              <Switch value={askApproval} onValueChange={setAskApproval} accessibilityLabel="Ask a supervisor to check it" />
            </View>
          )}

          {mode === "complete" &&
            fields.map((f) => (
              <Field
                key={f.key}
                label={f.required ? f.label : `${f.label} (optional)`}
                value={capture[f.key] ?? ""}
                onChangeText={(t) => setCapture((prev) => ({ ...prev, [f.key]: t }))}
                multiline={f.multiline}
                placeholder={f.placeholder}
                maxLength={2000}
              />
            ))}

          {mode !== "finalize" && (
            <AttachmentPicker
              items={files}
              onChange={setFiles}
              required={needPhotos}
              hint={mode === "complete" ? "A clear photo of the finished work, from where you did it." : "A photo of what's in the way helps the office plan the next visit."}
            />
          )}

          {needsGps && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <MapPin size={16} color={point ? c.success : c.warning} />
              <Text v="small" tone={point ? "muted" : "warning"} style={{ flex: 1 }}>
                {point ? `This kind of job records where you are${accuracyM !== null ? ` (about ${Math.round(accuracyM)} m)` : ""}.` : "This kind of job records where you are. Turn on location."}
              </Text>
            </View>
          )}

          <Field
            label={noteNeeded ? "Note" : "Note (optional)"}
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={2000}
            placeholder={mode === "incomplete" ? "What's in the way? What's needed to carry on?" : "What did you do? Anything the office should know?"}
            hint={`${note.length}/2000`}
          />
        </ScrollView>
        <Footer>
          <Button label={label} disabled={!!issue} loading={saving} onPress={save} />
          <Hint issue={issue}>
            {mode === "complete" && submit ? "A supervisor checks it before the job is closed." : mode === "incomplete" ? "The office will see why and can reassign or reschedule it." : "Saved on this phone and uploaded when you're online."}
          </Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
