import { nearestPipe } from "@flowless/network";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { LocationCard } from "../../components/location-card";
import { Button, Card, Field, Footer, Header, Hint, Label, Screen, Text } from "../../components/ui";
import type { LatLng } from "../../lib/types";
import { useField, useNetwork } from "../../state/app";

/**
 * Capture a service connection (G-01): where it is and its number. It goes on the job's changes (or
 * the member's own) for review, like any other new asset. The nearest pipe is only a suggestion, and
 * whoever reviews it can correct the link. Customers are Accounts' business, not GIS's: once the
 * connection is live, Accounts is told (`gis.connection_posted`) and links a service point.
 */
export default function CaptureConnection() {
  const { workOrderId } = useLocalSearchParams<{ workOrderId?: string }>();
  const router = useRouter();
  const { pipes, connections } = useNetwork();
  const { addConnection } = useField();
  const [connectionNumber, setConnectionNumber] = useState("");
  const [location, setLocation] = useState<LatLng | null>(null);
  const [useSuggestion, setUseSuggestion] = useState(true);

  const suggested = useMemo(() => (location ? nearestPipe(location, pipes) : null), [location, pipes]);
  const number = connectionNumber.trim();
  const taken = number.length > 0 && connections.some((x) => x.connectionNumber.toLowerCase() === number.toLowerCase());
  const issue = !number ? "Enter the connection number" : !location ? "Use your location at the connection" : taken ? "That connection number is already on the map" : null;

  function save() {
    if (issue || !location) return;
    addConnection({ connectionNumber: number, location, pipeId: useSuggestion ? (suggested?.pipeId ?? null) : null }, workOrderId);
    router.back();
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <Header title="Capture connection" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 20 }} keyboardShouldPersistTaps="handled">
          <Field
            label="Connection number"
            value={connectionNumber}
            onChangeText={setConnectionNumber}
            maxLength={60}
            autoCapitalize="characters"
            placeholder="e.g. KW-00142"
            error={taken ? "That number is already on the map. Check it." : undefined}
          />
          <View style={{ gap: 8 }}>
            <Label>Where is the connection?</Label>
            <LocationCard value={location} onChange={setLocation} empty="Stand at the connection and use your location." />
          </View>
          {location && (
            <Card style={{ gap: 8, padding: 14 }}>
              <Label>Serving pipe</Label>
              {suggested && useSuggestion ? (
                <>
                  <Text>Nearest pipe, {Math.round(suggested.distanceM)} m away</Text>
                  <Button label="It's not this pipe" variant="ghost" compact onPress={() => setUseSuggestion(false)} />
                </>
              ) : (
                <Text tone="muted">{suggested ? "Left for the reviewer to link." : "No mapped pipe nearby. The reviewer can link it later."}</Text>
              )}
            </Card>
          )}
        </ScrollView>
        <Footer>
          <Button label="Save connection" disabled={!!issue} onPress={save} />
          <Hint issue={issue}>Saved on this phone. Reviewed before it goes on the map.</Hint>
        </Footer>
      </KeyboardAvoidingView>
    </Screen>
  );
}
