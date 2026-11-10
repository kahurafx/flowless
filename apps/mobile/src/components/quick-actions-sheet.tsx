import { useRouter, type Href } from "expo-router";
import { Box, CircleDot, Gauge, ClipboardCheck, MapPin, Plug, Route, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { radius, useTheme } from "../lib/theme";
import { useJobs, useSession } from "../state/app";
import { Row, Text } from "./ui";

type Action = { key: string; label: string; hint: string; icon: LucideIcon; href: Href };

const ACTIONS: Action[] = [
  { key: "inspect", label: "Record inspection", hint: "Log the condition of an asset", icon: ClipboardCheck, href: { pathname: "/select-asset", params: { purpose: "inspect" } } },
  { key: "valve", label: "Operate a valve", hint: "Log a valve opened or closed", icon: CircleDot, href: { pathname: "/select-asset", params: { purpose: "valve" } } },
  { key: "node", label: "Add a node", hint: "Valve, meter, hydrant, junction…", icon: MapPin, href: { pathname: "/add-asset", params: { kind: "node" } } },
  { key: "pipe", label: "Add a pipe", hint: "Connect two existing nodes", icon: Route, href: { pathname: "/add-asset", params: { kind: "pipe" } } },
  { key: "structure", label: "Add a structure", hint: "Manhole, chamber, vault, kiosk", icon: Box, href: { pathname: "/add-asset", params: { kind: "structure" } } },
  { key: "connection", label: "Capture a connection", hint: "A service connection on a pipe", icon: Plug, href: "/capture-connection" },
  { key: "readings", label: "Reading round", hint: "Read meters on your route", icon: Gauge, href: "/reading-round" },
  { key: "report", label: "Report a problem", hint: "Raise a job for something you found", icon: TriangleAlert, href: "/report" },
];

export default function QuickActionsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const { c } = useTheme();
  const { abilities, hasGis } = useSession();
  const { kinds } = useJobs();

  // Network actions need GIS and edit rights; "Report a problem" raises a job, so only where this person may.
  const canReport = abilities.seeJobs && abilities.act && kinds.some((k) => k.canRaise);
  const shown = ACTIONS.filter((a) => (a.key === "report" ? canReport : a.key === "readings" ? abilities.readings : hasGis && abilities.edit));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end" }}>
        <View style={{ borderTopLeftRadius: radius["3xl"], borderTopRightRadius: radius["3xl"], backgroundColor: c.popover, paddingHorizontal: 12, paddingBottom: 40, paddingTop: 12 }}>
          <View style={{ alignSelf: "center", width: 40, height: 6, borderRadius: 3, backgroundColor: c.border, marginBottom: 8 }} />
          <Text v="title" style={{ paddingHorizontal: 8, paddingBottom: 8, paddingTop: 4 }}>
            What would you like to do?
          </Text>
          {shown.map((a) => (
            <Row
              key={a.key}
              onPress={() => {
                onClose();
                router.push(a.href);
              }}
              style={{ borderRadius: radius["2xl"], paddingHorizontal: 8 }}
            >
              <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: c.accent }}>
                <a.icon size={21} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text bold>{a.label}</Text>
                <Text v="small" tone="muted">
                  {a.hint}
                </Text>
              </View>
            </Row>
          ))}
          {shown.length === 0 && (
            <Text tone="muted" style={{ padding: 8 }}>
              Nothing to add with your permissions.
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}
