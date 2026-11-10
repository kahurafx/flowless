import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchX } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { AttachmentPicker } from "../../../components/attachment-picker";
import { Button, Card, EmptyState, Field, Footer, Header, Hint, Notice, Screen, SearchField, Text } from "../../../components/ui";
import { api } from "../../../lib/api";
import { checkMeterChange } from "../../../lib/meter-change";
import { useLocation } from "../../../lib/location";
import { radius, useTheme } from "../../../lib/theme";
import type { LocalFile, MeterRow } from "../../../lib/types";
import { useReadings, useSession, useSync } from "../../../state/app";

/**
 * Meter change (M-07): the old meter's final reading, the new meter and its first reading, sent as one
 * `installations.replace`. Finding the new meter needs the register, so it needs signal; the rest is
 * local and the change itself is queued.
 */
export default function MeterChange() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { abilities } = useSession();
  const { online } = useSync();
  const { point } = useLocation();
  const { tasks, changeMeter } = useReadings();
  const task = tasks.find((t) => t.id === taskId);

  const [search, setSearch] = useState("");
  const [found, setFound] = useState<MeterRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<MeterRow | null>(null);
  const [finalText, setFinalText] = useState("");
  const [finalRollover, setFinalRollover] = useState(false);
  const [initialText, setInitialText] = useState("");
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);

  if (!abilities.changeMeter || !task || !task.meterId) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Meter change" />
        <EmptyState icon={SearchX} title="Not available" body="You can't replace this meter from here." />
      </Screen>
    );
  }

  async function lookUp() {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.metering.meters.list.query({ search: search.trim(), kind: "customer", limit: 20 });
      // A meter that can be installed: not already on a service point, not retired.
      setFound(res.meters.filter((m) => ["in_stock", "issued", "tested"].includes(m.status) && m.id !== task?.meterId));
    } catch {
      setSearchError("Couldn't reach the register. Check your connection and try again.");
    }
    setSearching(false);
  }

  const check = checkMeterChange(task, chosen, finalText, finalRollover, initialText, reason, new Date());

  function save() {
    if (!check.ok || !chosen || !task) return;
    changeMeter({
      task,
      newMeter: { id: chosen.id, serial: chosen.serial, dialDigits: chosen.dialDigits },
      finalValue: check.finalValue,
      finalRolloverConfirmed: finalRollover,
      initialValue: check.initialValue,
      reason,
      files,
      ...(point ? { position: { latitude: point.lat, longitude: point.lng } } : {}),
    });
    router.dismissAll();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Meter change" subtitle={task.accountNumber ?? undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 18 }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: 4, padding: 14 }}>
            <Text bold>Old meter {task.meter?.serial ?? ""}</Text>
            <Text v="small" tone="muted">
              {task.previous ? `Last reading ${task.previous.value}` : "No earlier reading"}
            </Text>
          </Card>

          <Field label={`Old meter final reading${task.meter ? ` (${task.meter.dialDigits} digits)` : ""}`} value={finalText} onChangeText={(t) => { setFinalText(t); setFinalRollover(false); }} keyboardType="number-pad" error={check.finalError} />
          {check.finalNeedsRollover && (
            <Notice tone="warn">
              <Text v="small">That is lower than the last reading. Did the old dial go all the way round?</Text>
              <Button label={finalRollover ? "Yes, it went round" : "Yes, it went round"} compact variant={finalRollover ? "primary" : "secondary"} onPress={() => setFinalRollover(true)} style={{ marginTop: 8 }} />
            </Notice>
          )}

          <View style={{ gap: 8 }}>
            <Text v="small" bold>
              New meter
            </Text>
            {chosen ? (
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }}>
                <View>
                  <Text bold>{chosen.serial}</Text>
                  <Text v="small" tone="muted">
                    {chosen.model || "Meter"} · {chosen.dialDigits} digits
                  </Text>
                </View>
                <Button label="Change" variant="ghost" compact onPress={() => setChosen(null)} />
              </Card>
            ) : (
              <>
                <SearchField value={search} onChangeText={setSearch} placeholder="New meter serial" />
                <Button label="Find meter" variant="secondary" compact disabled={!online || search.trim() === ""} loading={searching} onPress={lookUp} />
                {!online && <Hint issue="Finding the new meter needs a connection" />}
                {searchError && (
                  <Text v="small" tone="danger">
                    {searchError}
                  </Text>
                )}
                {searching && <ActivityIndicator />}
                {found?.length === 0 && <Text v="small" tone="muted">No installable meter matches. It must be in stock, issued or tested.</Text>}
                {found?.map((m) => (
                  <Pressable key={m.id} onPress={() => setChosen(m)} accessibilityRole="button" style={{ minHeight: 52, justifyContent: "center", borderRadius: radius.xl, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, paddingHorizontal: 14 }}>
                    <Text bold>{m.serial}</Text>
                    <Text v="small" tone="muted">
                      {m.model || "Meter"} · {m.dialDigits} digits · {m.status.replace("_", " ")}
                    </Text>
                  </Pressable>
                ))}
              </>
            )}
          </View>

          <Field label="New meter first reading" value={initialText} onChangeText={setInitialText} keyboardType="number-pad" error={check.initialError} />
          <Field label="Reason" value={reason} onChangeText={setReason} placeholder="For example: meter stopped, ageing, damaged" maxLength={500} />
          <AttachmentPicker items={files} onChange={setFiles} hint="Photograph the old meter's final dial." />
        </ScrollView>
        <Footer>
          <Button label="Save meter change" disabled={!check.ok} onPress={save} />
          <Hint>Both readings are sent together. Uploads when you&apos;re online.</Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
