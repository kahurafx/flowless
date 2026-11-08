import { useLocalSearchParams, useRouter } from "expo-router";
import { Info, SearchX } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { TypeTile } from "../../../components/asset-row";
import { Button, Card, EmptyState, Field, Footer, Header, Notice, Screen, Text } from "../../../components/ui";
import { radius, useTheme } from "../../../lib/theme";
import { useField, useNetwork } from "../../../state/app";

function Choice({ open, active, current, onPick }: { open: boolean; active: boolean; current: boolean; onPick: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPick}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      style={{ height: 112, flex: 1, alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radius["2xl"], borderWidth: 2, borderColor: active ? c.primary : c.border, backgroundColor: active ? c.accent : c.card }}
    >
      <Text v="title">{open ? "Open" : "Closed"}</Text>
      <Text v="small" tone="muted">
        {current ? "Current state" : open ? "Water flows" : "Flow stopped"}
      </Text>
    </Pressable>
  );
}

export default function OperateValve() {
  const { id, workOrderId } = useLocalSearchParams<{ id: string; workOrderId?: string }>();
  const router = useRouter();
  const { nodes } = useNetwork();
  const { operateValve } = useField();
  const node = nodes.find((n) => n.id === id && n.type === "valve");
  const [target, setTarget] = useState<boolean | null>(null);
  const [note, setNote] = useState("");

  if (!node) {
    return (
      <Screen edges={["top", "bottom"]}>
        <Header title="Operate valve" />
        <EmptyState icon={SearchX} title="Valve not found" />
      </Screen>
    );
  }

  const same = target !== null && target === node.isOpen;

  function save() {
    if (target === null || !node) return;
    operateValve(node.id, target, note, workOrderId);
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Operate valve" subtitle={workOrderId ? "For the job" : undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          <Card style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
            <TypeTile type="valve" />
            <View style={{ flex: 1 }}>
              <Text bold numberOfLines={1}>
                {node.name}
              </Text>
              <Text v="small" tone="muted">
                Currently {node.isOpen === true ? "open" : node.isOpen === false ? "closed" : "in an unknown state"}
              </Text>
            </View>
          </Card>

          <View style={{ gap: 8 }}>
            <Text bold>What did you do?</Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Choice open active={target === true} current={node.isOpen === true} onPick={() => setTarget(true)} />
              <Choice open={false} active={target === false} current={node.isOpen === false} onPick={() => setTarget(false)} />
            </View>
          </View>

          {same && (
            <Notice tone="neutral" icon={Info}>
              The valve is already recorded as {target ? "open" : "closed"}. You can still log it to confirm the state.
            </Notice>
          )}

          <Field label="Note (optional)" value={note} onChangeText={setNote} multiline maxLength={2000} placeholder="Why was it operated? Turns counted, resistance, leaks…" />
        </ScrollView>
        <Footer>
          <Button label={target === null ? "Choose open or closed" : `Log valve as ${target ? "open" : "closed"}`} disabled={target === null} onPress={save} />
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
