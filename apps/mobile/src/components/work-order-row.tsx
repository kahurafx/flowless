import { Check, ChevronRight, ClipboardCheck, ClipboardList, Cog, Droplets, Gauge, MapPin, MapPinOff, MapPinPlus, Pencil, Radar, RotateCw, Waves, Wrench, type LucideIcon } from "lucide-react-native";
import { View } from "react-native";
import { formatDistance, timeAgo } from "../lib/format";
import { useTheme } from "../lib/theme";
import { dueLabel, jobProgress, personName, type RankedOrder } from "../lib/work-orders";
import { Row, StatusPill, Text } from "./ui";

const KIND_ICON: Record<string, LucideIcon> = {
  leak: Droplets,
  leak_survey: Radar,
  valve_replacement: Wrench,
  valve_exercise: RotateCw,
  flushing: Waves,
  inspection: ClipboardCheck,
  inspection_general: ClipboardCheck,
  prv_adjustment: Gauge,
  facility_service: Cog,
  asset_capture: MapPinPlus,
  connection_capture: MapPinPlus,
  asset_update: Pencil,
  repair: Wrench,
  survey: Radar,
};
/** Kinds are strings (a module can add one without an app update), so an unknown one still gets an icon. */
export function KindIcon({ kind, size, color }: { kind: string; size: number; color: string }) {
  const Icon = KIND_ICON[kind] ?? ClipboardList;
  return <Icon size={size} color={color} />;
}

/** `showWho` is for the approval queue: who sent it matters more than where it is. */
export function WorkOrderRow({ item, me, onPress, showWho }: { item: RankedOrder; me: string; onPress: () => void; showWho?: boolean }) {
  const { c } = useTheme();
  const { order, distanceM } = item;
  const completed = order.status === "completed";
  const submitted = order.status === "submitted";
  const due = dueLabel(order.dueAt);
  const { done, total } = jobProgress(order);
  const sentBack = order.reviewed?.decision === "returned" && order.status === "in_progress";
  const where = distanceM !== null ? `${formatDistance(distanceM)} away` : (order.locationNote ?? "No location yet");

  return (
    <Row onPress={onPress} style={{ minHeight: 92 }}>
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: completed ? c.successSoft : c.accent }}>
        {completed ? <Check size={21} color={c.success} /> : <KindIcon kind={order.kind} size={21} color={c.primary} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text bold numberOfLines={1}>
          {order.title}
        </Text>
        {!completed && !submitted && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {distanceM !== null ? <MapPin size={14} color={c.mutedForeground} /> : <MapPinOff size={14} color={c.input} />}
            <Text v="small" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {where}
            </Text>
          </View>
        )}
        <Text v="small" tone="muted">
          {order.code} ·{" "}
          {completed ? (
            `Done ${timeAgo(order.completion?.at)}`
          ) : submitted ? (
            showWho ? `${personName(order.submission?.byUserId, me)}, ${timeAgo(order.submission?.at)}` : "Waiting for approval"
          ) : order.status === "blocked" ? (
            order.hold?.reason
          ) : total > 1 && order.status === "in_progress" ? (
            `${done} of ${total} assets`
          ) : (
            <Text v="small" tone={due.overdue ? "danger" : "muted"} bold={due.overdue}>
              {due.text}
            </Text>
          )}
        </Text>
      </View>
      {sentBack ? (
        <StatusPill label="Sent back" tone="warn" />
      ) : order.status === "in_progress" ? (
        <StatusPill label="In progress" tone="info" />
      ) : order.status === "blocked" ? (
        <StatusPill label="On hold" tone="warn" />
      ) : submitted && !showWho ? (
        <StatusPill label="Sent" tone="info" />
      ) : order.priority === "urgent" && order.status === "pending" ? (
        <StatusPill label="Urgent" tone="danger" />
      ) : order.priority === "high" && order.status === "pending" ? (
        <StatusPill label="High" tone="warn" />
      ) : null}
      <ChevronRight size={18} color={c.input} />
    </Row>
  );
}
