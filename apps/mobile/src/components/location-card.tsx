import { LocateFixed, MapPin } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { formatCoords } from "../lib/format";
import { useLocation } from "../lib/location";
import { useTheme } from "../lib/theme";
import type { LatLng } from "../lib/types";
import { Button, Card, Text } from "./ui";

/** Take the phone's GPS position as a place. Asks for permission the first time, and says how accurate the fix is. */
export function LocationCard({ value, onChange, empty }: { value: LatLng | null; onChange: (p: LatLng) => void; empty: string }) {
  const { c } = useTheme();
  const { status, request, refresh } = useLocation();
  const [fixing, setFixing] = useState(false);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);

  async function useMyLocation() {
    setFixing(true);
    if (status !== "granted" && !(await request())) return setFixing(false);
    const fix = await refresh();
    setFixing(false);
    if (fix) {
      onChange(fix.point);
      setAccuracyM(fix.accuracyM);
    }
  }

  return (
    <Card style={{ gap: 12, padding: 14 }}>
      {value ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <MapPin size={18} color={c.primary} />
          <Text bold style={{ flex: 1 }}>
            {formatCoords(value)}
          </Text>
        </View>
      ) : (
        <Text tone="muted">{empty}</Text>
      )}
      <Button label={fixing ? "Finding you…" : value ? "Update from GPS" : "Use my location"} variant="secondary" icon={LocateFixed} loading={fixing} compact onPress={useMyLocation} />
      {accuracyM !== null && (
        <Text v="small" tone={accuracyM > 30 ? "warning" : "faint"}>
          Accurate to about {Math.round(accuracyM)} m{accuracyM > 30 ? ". Weak signal: move into the open and try again." : "."}
        </Text>
      )}
    </Card>
  );
}
