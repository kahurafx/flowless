import { Building2, Check, CloudOff, LogOut } from "lucide-react-native";
import { Alert, ScrollView, Switch, View } from "react-native";
import { Button, Card, Screen, SectionHeader, Text } from "../../../components/ui";
import { abilityLines, roleLabel } from "../../../lib/permissions";
import { TAB_SPACE, useTheme } from "../../../lib/theme";
import { useSession, useSync } from "../../../state/app";

export default function ProfileScreen() {
  const { c } = useTheme();
  const { user, org, role, abilities, signOut } = useSession();
  const { workOffline, setWorkOffline, pending, online } = useSync();

  const confirmSignOut = () => {
    if (pending === 0) return void signOut();
    Alert.alert(
      "Sign out with unsent work?",
      `${pending} change${pending === 1 ? " hasn't" : "s haven't"} uploaded yet. ${pending === 1 ? "It stays" : "They stay"} on this phone and ${pending === 1 ? "uploads" : "upload"} after you sign back in.`,
      [{ text: "Stay signed in", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => void signOut() }],
    );
  };

  const initials = user.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  // Staff usernames are stored as "<code>.<name>"; show the name part.
  const login = user.username.startsWith(`${org.slug}.`) ? user.username.slice(org.slug.length + 1) : user.username;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: TAB_SPACE + 16 }} showsVerticalScrollIndicator={false}>
        <Text v="heading" style={{ paddingHorizontal: 4, paddingBottom: 16 }}>
          Profile
        </Text>

        <Card style={{ flexDirection: "row", alignItems: "center", gap: 16, padding: 16 }}>
          <View style={{ width: 64, height: 64, alignItems: "center", justifyContent: "center", borderRadius: 32, backgroundColor: c.primary }}>
            <Text v="title" tone="inverse">
              {initials}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text v="lead" bold>
              {user.name}
            </Text>
            {login ? (
              <Text v="small" tone="muted">
                {login} · {org.slug.toUpperCase()}
              </Text>
            ) : null}
            <View style={{ marginTop: 4, flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Building2 size={14} color={c.mutedForeground} />
              <Text v="small" tone="muted">
                {org.name}
              </Text>
            </View>
          </View>
        </Card>

        <SectionHeader title={`What a ${roleLabel(role).toLowerCase()} can do`} />
        <Card style={{ gap: 12, padding: 16 }}>
          {abilityLines(abilities).map((line) => (
            <View key={line} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <Check size={18} color={c.success} style={{ marginTop: 2 }} />
              <Text style={{ flex: 1 }}>{line}</Text>
            </View>
          ))}
        </Card>

        <SectionHeader title="Connection" />
        <Card style={{ padding: 16 }}>
          <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <CloudOff size={20} color={c.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text>Work offline</Text>
              <Text v="small" tone="muted">
                {workOffline ? "Nothing uploads until you turn this off." : online ? "Changes upload when you sync." : "No signal. Changes wait on this phone."}
              </Text>
            </View>
            <Switch value={workOffline} onValueChange={setWorkOffline} accessibilityLabel="Work offline" />
          </View>
        </Card>

        <View style={{ marginTop: 24, gap: 12 }}>
          <Button label="Sign out" variant="secondary" icon={LogOut} onPress={confirmSignOut} />
          <Text v="small" tone="faint" style={{ textAlign: "center" }}>
            Flowless field app 1.0.0
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
