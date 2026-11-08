import { Tabs } from "expo-router";
import { House, List, Map as MapIcon, Plus, User } from "lucide-react-native";
import { useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import QuickActionsSheet from "../../../components/quick-actions-sheet";
import { haptic } from "../../../lib/haptics";
import { useTheme } from "../../../lib/theme";
import { useJobs, useSession } from "../../../state/app";

/** Height of the tab bar above the safe area. */
const BAR = 60;

export default function TabsLayout() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { abilities, hasGis } = useSession();
  const { kinds } = useJobs();
  const [open, setOpen] = useState(false);

  // Something to add: network records (GIS and edit rights) or a reported problem (raising a job).
  const canAdd = (hasGis && abilities.edit) || (abilities.seeJobs && abilities.act && kinds.some((k) => k.canRaise));

  return (
    <>
      <Tabs
        screenListeners={{ tabPress: () => haptic.select() }}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: c.primary,
          tabBarInactiveTintColor: c.mutedForeground,
          tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
          tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border, height: BAR + insets.bottom, paddingTop: 6 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ({ color, size }) => <House size={size} color={color} /> }} />
        <Tabs.Screen name="map" options={{ title: "Map", href: hasGis ? undefined : null, tabBarIcon: ({ color, size }) => <MapIcon size={size} color={color} /> }} />
        <Tabs.Screen name="assets" options={{ title: "Assets", href: hasGis ? undefined : null, tabBarIcon: ({ color, size }) => <List size={size} color={color} /> }} />
        <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: ({ color, size }) => <User size={size} color={color} /> }} />
      </Tabs>
      {canAdd && (
        <Pressable
          onPress={() => {
            haptic.tap();
            setOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Quick actions"
          style={({ pressed }) => ({
            position: "absolute",
            right: 16,
            bottom: BAR + insets.bottom + 16,
            width: 56,
            height: 56,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 28,
            backgroundColor: c.primary,
            opacity: pressed ? 0.8 : 1,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 3 },
            elevation: 8,
          })}
        >
          <Plus size={26} color={c.primaryForeground} />
        </Pressable>
      )}
      <QuickActionsSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
