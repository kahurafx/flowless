import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LocationProvider } from "../lib/location";
import { useTheme } from "../lib/theme";
import { AppProvider, useSession } from "../state/app";

function Routes() {
  const { signedIn, booting } = useSession();
  const { c } = useTheme();

  // Until the phone knows whether it has a session, show nothing that could flash the wrong screen.
  if (booting) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <LocationProvider>
          <StatusBar style="auto" />
          <Routes />
        </LocationProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}
