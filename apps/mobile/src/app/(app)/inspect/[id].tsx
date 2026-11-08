import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, SearchX } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { AttachmentPicker } from "../../../components/attachment-picker";
import { TypeTile } from "../../../components/asset-row";
import { Button, Card, EmptyState, Field, Footer, Header, Hint, Screen, Text } from "../../../components/ui";
import { CONDITION_HEX, CONDITION_HINT, CONDITION_LABEL, NODE_TYPE_LABEL } from "../../../lib/format";
import { radius, useTheme } from "../../../lib/theme";
import type { LocalFile } from "../../../lib/types";
import { ASSET_CONDITIONS, type AssetCondition } from "@flowless/shared-types";
import { useField, useNetwork } from "../../../state/app";

export default function RecordInspection() {
  const { id, workOrderId } = useLocalSearchParams<{ id: string; workOrderId?: string }>();
  const router = useRouter();
  const { c } = useTheme();
  const { nodes } = useNetwork();
  const { recordCondition } = useField();
  const node = nodes.find((n) => n.id === id);
  const [condition, setCondition] = useState<AssetCondition | null>(null);
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<LocalFile[]>([]);

  if (!node) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Record inspection" />
        <EmptyState icon={SearchX} title="Asset not found" />
      </Screen>
    );
  }

  function save() {
    if (!condition || !node) return;
    recordCondition(node.id, condition, note, workOrderId, files);
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Record inspection" subtitle={workOrderId ? "For the job" : undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          <Card style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
            <TypeTile type={node.type} />
            <View style={{ flex: 1 }}>
              <Text bold numberOfLines={1}>
                {node.name}
              </Text>
              <Text v="small" tone="muted">
                {NODE_TYPE_LABEL[node.type]} · currently {CONDITION_LABEL[node.condition].toLowerCase()}
              </Text>
            </View>
          </Card>

          <View style={{ gap: 8 }}>
            <Text bold>What condition is it in?</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {ASSET_CONDITIONS.map((o) => {
                const active = condition === o;
                return (
                  <Pressable
                    key={o}
                    onPress={() => setCondition(o)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    style={{ width: "47.8%", minHeight: 88, gap: 6, borderRadius: radius["2xl"], borderWidth: 2, padding: 14, borderColor: active ? c.primary : c.border, backgroundColor: active ? c.accent : c.card }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: CONDITION_HEX[o] }} />
                      {active && <Check size={18} color={c.primary} />}
                    </View>
                    <Text bold>{CONDITION_LABEL[o]}</Text>
                    <Text v="small" tone="muted">
                      {CONDITION_HINT[o]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={2000} placeholder="What did you see? Leaks, corrosion, access problems…" hint={`${note.length}/2000`} />
          <AttachmentPicker items={files} onChange={setFiles} hint="A photo of what you found helps whoever follows up." />
        </ScrollView>
        <Footer>
          <Button label="Save inspection" disabled={!condition} onPress={save} />
          <Hint>Saved with the time on your phone. Uploads when you&apos;re online.</Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
