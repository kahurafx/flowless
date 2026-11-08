import { Modal, Pressable, StyleSheet, Switch, View } from "react-native";
import { CONDITION_HEX, CONDITION_LABEL } from "../lib/format";
import { SUBNETWORK_FALLBACK } from "../lib/map-style";
import { radius, useTheme } from "../lib/theme";
import type { AssetCondition } from "@flowless/shared-types";
import { Segmented, Text } from "./ui";

export type ColorMode = "condition" | "subnetwork";
const CONDITIONS: AssetCondition[] = ["good", "fair", "poor", "critical", "unknown"];

const Swatch = ({ color, label }: { color: string; label: string }) => (
  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
    <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} />
    <Text v="small" tone="muted">
      {label}
    </Text>
  </View>
);

const SwitchRow = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
  <View style={{ minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
    <Text>{label}</Text>
    <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
  </View>
);

export function MapLayersSheet({
  visible, onClose, colorMode, onColorMode, showDmas, onShowDmas, showPipes, onShowPipes, showConnections, onShowConnections, subnetworks,
}: {
  visible: boolean;
  onClose: () => void;
  colorMode: ColorMode;
  onColorMode: (m: ColorMode) => void;
  showDmas: boolean;
  onShowDmas: (v: boolean) => void;
  showPipes: boolean;
  onShowPipes: (v: boolean) => void;
  showConnections: boolean;
  onShowConnections: (v: boolean) => void;
  subnetworks: { id: string; name: string; color: string }[];
}) {
  const { c } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end" }}>
        <View style={{ gap: 16, borderTopLeftRadius: radius["3xl"], borderTopRightRadius: radius["3xl"], backgroundColor: c.popover, paddingHorizontal: 16, paddingBottom: 40, paddingTop: 12 }}>
          <View style={{ alignSelf: "center", width: 40, height: 6, borderRadius: 3, backgroundColor: c.border }} />
          <Text v="title">Map layers</Text>

          <View style={{ gap: 8 }}>
            <Text v="small" bold>
              Colour assets by
            </Text>
            <Segmented<ColorMode> value={colorMode} onChange={onColorMode} options={[{ value: "condition", label: "Condition" }, { value: "subnetwork", label: "Subnetwork" }]} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 8, paddingTop: 4 }}>
              {colorMode === "condition"
                ? CONDITIONS.map((k) => <Swatch key={k} color={CONDITION_HEX[k]} label={CONDITION_LABEL[k]} />)
                : [...subnetworks.map((sn) => <Swatch key={sn.id} color={sn.color} label={sn.name} />), <Swatch key="none" color={SUBNETWORK_FALLBACK} label="Not in a subnetwork" />]}
            </View>
          </View>

          <View>
            <SwitchRow label="District metered areas (DMAs)" value={showDmas} onChange={onShowDmas} />
            <SwitchRow label="Pipes" value={showPipes} onChange={onShowPipes} />
            <SwitchRow label="Service connections" value={showConnections} onChange={onShowConnections} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
