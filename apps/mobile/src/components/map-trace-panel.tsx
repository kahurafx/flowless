import { TriangleAlert, X } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { TRACE_HEX, TRACE_ORIGIN } from "../lib/map-style";
import { radius, TOUCH, useTheme } from "../lib/theme";
import type { AppNode, Connection } from "../lib/types";
import { Button, Notice, Segmented, Text } from "./ui";

export type TraceMode = "upstream" | "downstream" | "isolation";
export type TraceResult = {
  affected: AppNode[];
  valvesToClose: AppNode[];
  alreadyClosed: AppNode[];
  deadEnds: number;
  /** Only for a simulated break. */
  customers?: { onSection: Connection[]; alsoLosingSupply: Connection[]; supplyKnown: boolean; unlinkedCount: number };
};

/**
 * Field version of the web trace card. Isolation answers "if this pipe breaks, which valves do I
 * close?", with a way out when a valve won't turn. Runs the shared `@flowless/network` algorithms on
 * the phone, offline, so the answer matches the server's.
 */
export function MapTracePanel({
  mode, onMode, result, onSkip, onClear, onOpen,
}: {
  mode: TraceMode;
  onMode: (m: TraceMode) => void;
  result: TraceResult | null;
  onSkip: (valveId: string) => void;
  onClear: () => void;
  onOpen: (id: string) => void;
}) {
  const { c } = useTheme();
  const shown = result?.affected.slice(0, 4) ?? [];
  const served = result?.customers ? result.customers.onSection.length + result.customers.alsoLosingSupply.length : 0;
  return (
    <View style={{ gap: 12, borderRadius: radius["3xl"], borderWidth: 1, borderColor: c.border, backgroundColor: c.card, padding: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text v="lead" bold>
          Trace
        </Text>
        <Pressable onPress={onClear} accessibilityRole="button" accessibilityLabel="Close trace" hitSlop={10} style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
          <X size={20} color={c.mutedForeground} />
        </Pressable>
      </View>
      <Segmented<TraceMode> value={mode} onChange={onMode} options={[{ value: "isolation", label: "Isolation" }, { value: "downstream", label: "Downstream" }, { value: "upstream", label: "Upstream" }]} />

      {mode !== "isolation" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: TRACE_HEX[mode] }} />
          <Text v="small" tone="muted">
            {mode === "upstream" ? "Upstream" : "Downstream"} assets
          </Text>
          <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 2.5, borderColor: TRACE_ORIGIN, marginLeft: 8 }} />
          <Text v="small" tone="muted">
            Start
          </Text>
        </View>
      )}

      {!result ? (
        <Text v="small" tone="muted">
          {mode === "isolation" ? "Tap a pipe on the map to simulate a break." : "Tap an asset on the map to start."}
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 250 }} contentContainerStyle={{ gap: 12 }} showsVerticalScrollIndicator={false}>
          <Text>
            <Text bold>{result.affected.length}</Text> asset{result.affected.length === 1 ? "" : "s"} affected
          </Text>

          {result.customers && (
            <View style={{ gap: 4 }}>
              <Text>
                <Text bold>{result.customers.onSection.length}</Text> connection{result.customers.onSection.length === 1 ? "" : "s"} on this section
                {result.customers.supplyKnown && (
                  <Text>
                    {" "}
                    · <Text bold>{result.customers.alsoLosingSupply.length}</Text> also losing supply
                  </Text>
                )}
              </Text>
              {[...result.customers.onSection, ...result.customers.alsoLosingSupply].slice(0, 4).map((x) => (
                <Text key={x.id} v="small" tone="muted" numberOfLines={1}>
                  {x.connectionNumber}
                </Text>
              ))}
              {served > 4 && (
                <Text v="small" tone="faint">
                  and {served - 4} more
                </Text>
              )}
              {!result.customers.supplyKnown && (
                <Text v="small" tone="warning">
                  No reservoir or pumping station is mapped, so who else loses supply can&apos;t be worked out.
                </Text>
              )}
              {result.customers.unlinkedCount > 0 && (
                <Text v="small" tone="warning">
                  {result.customers.unlinkedCount} connection{result.customers.unlinkedCount === 1 ? " isn't" : "s aren't"} linked to a pipe, so {result.customers.unlinkedCount === 1 ? "it" : "they"} can&apos;t be judged.
                </Text>
              )}
              {result.customers.supplyKnown && (
                <Text v="small" tone="faint">
                  Others may still get low pressure.
                </Text>
              )}
            </View>
          )}

          {result.deadEnds > 0 && (
            <Notice tone="danger" icon={TriangleAlert}>
              {result.deadEnds === 1 ? "A supply source is" : `${result.deadEnds} supply sources are`} connected to the break with no valve in between. Closing valves won&apos;t isolate it.
            </Notice>
          )}

          {result.valvesToClose.length > 0 && (
            <View style={{ gap: 4 }}>
              <Text v="small" bold>
                Valves to close
              </Text>
              {result.valvesToClose.map((v) => (
                <View key={v.id} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <Text numberOfLines={1} style={{ flex: 1 }}>
                    {v.name}
                  </Text>
                  <Button label="Won't turn" variant="ghost" compact onPress={() => onSkip(v.id)} />
                </View>
              ))}
            </View>
          )}

          {result.alreadyClosed.length > 0 && (
            <Text v="small" tone="muted">
              Already closed: {result.alreadyClosed.map((v) => v.name).join(", ")}
            </Text>
          )}

          <View>
            {shown.map((n) => (
              <Pressable key={n.id} onPress={() => onOpen(n.id)} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: "center" }}>
                <Text tone="primary" numberOfLines={1}>
                  {n.name}
                </Text>
              </Pressable>
            ))}
            {result.affected.length > shown.length && (
              <Text v="small" tone="faint">
                and {result.affected.length - shown.length} more
              </Text>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
