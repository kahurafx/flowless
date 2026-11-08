import type { NodeType } from "@flowless/shared-types";
import { ChevronRight, CircleDot, Cog, Droplets, Gauge, Network, Waves, type LucideIcon } from "lucide-react-native";
import { View } from "react-native";
import { inspectionState, NODE_TYPE_LABEL, timeAgo } from "../lib/format";
import { useTheme } from "../lib/theme";
import type { AppNode } from "../lib/types";
import { ConditionBadge, Row, Text } from "./ui";

export const NODE_TYPE_ICON: Record<NodeType, LucideIcon> = {
  reservoir: Waves,
  pumping_station: Cog,
  valve: CircleDot,
  junction: Network,
  meter: Gauge,
  hydrant: Droplets,
};

/** A soft tint per node type behind its icon. */
export const NODE_TYPE_COLOR: Record<NodeType, string> = {
  reservoir: "#38BDF8",
  pumping_station: "#A78BFA",
  valve: "#FB923C",
  junction: "#FACC15",
  meter: "#67E8F9",
  hydrant: "#FB7185",
};

export function TypeTile({ type, size = 44 }: { type: NodeType; size?: number }) {
  const { c } = useTheme();
  const Icon = NODE_TYPE_ICON[type];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3.2, backgroundColor: NODE_TYPE_COLOR[type] + "40", alignItems: "center", justifyContent: "center" }}>
      <Icon size={size * 0.48} color={c.foreground} />
    </View>
  );
}

export function caption(node: AppNode): string {
  const state = node.type === "valve" ? (node.isOpen === true ? "Open" : node.isOpen === false ? "Closed" : "State unknown") : null;
  const insp = inspectionState(node.lastInspectedAt);
  const inspected = insp === "never" ? "Never inspected" : insp === "overdue" ? `Overdue · ${timeAgo(node.lastInspectedAt)}` : `Inspected ${timeAgo(node.lastInspectedAt)}`;
  return [NODE_TYPE_LABEL[node.type], state, inspected].filter(Boolean).join(" · ");
}

export function AssetRow({ node, onPress }: { node: AppNode; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Row onPress={onPress} style={{ minHeight: 76 }}>
      <TypeTile type={node.type} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text bold numberOfLines={1}>
          {node.name}
        </Text>
        <Text v="small" tone="muted" numberOfLines={1}>
          {node.pending ? "Not on the server yet · " : ""}
          {caption(node)}
        </Text>
      </View>
      <ConditionBadge condition={node.condition} />
      <ChevronRight size={18} color={c.input} />
    </Row>
  );
}
